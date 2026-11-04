using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace RelayEnterprise;

public sealed record ProxyState(int Flags, string Server, string Bypass);
public sealed record ProxySnapshot(string Owner, ProxyState Previous, string Expected);
public sealed class SystemProxy(string directory)
{
    readonly string recovery = Path.Combine(directory, "proxy-recovery.json");
    readonly string owner = Guid.NewGuid().ToString("N");
    public string Owner => owner;
    public string RecoveryPath => recovery;
    public bool NeedsRecovery => File.Exists(recovery);
    [StructLayout(LayoutKind.Sequential)]
    struct OptionList { public int Size; public nint Connection; public int Count; public int Error; public nint Options; }
    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct Option { [FieldOffset(0)] public int Kind; [FieldOffset(8)] public int Number; [FieldOffset(8)] public nint Text; }
    [DllImport("wininet.dll", EntryPoint = "InternetSetOptionW", SetLastError = true)]
    static extern bool InternetSetOption(nint internet, int option, nint buffer, int length);
    [DllImport("wininet.dll", EntryPoint = "InternetQueryOptionW", SetLastError = true)]
    static extern bool InternetQueryOption(nint internet, int option, nint buffer, ref int length);
    [DllImport("kernel32.dll")] static extern nint GlobalFree(nint memory);
    public static ProxyState ReadCurrent()
    {
        var size = Marshal.SizeOf<Option>(); var options = Marshal.AllocHGlobal(size * 3); var listPointer = Marshal.AllocHGlobal(Marshal.SizeOf<OptionList>());
        try
        {
            for (var i = 0; i < 3; i++) Marshal.StructureToPtr(new Option { Kind = i + 1 }, options + i * size, false);
            var list = new OptionList { Size = Marshal.SizeOf<OptionList>(), Count = 3, Options = options };
            Marshal.StructureToPtr(list, listPointer, false); var length = list.Size;
            if (!InternetQueryOption(0, 75, listPointer, ref length)) throw new ClientFailure("无法读取当前用户系统代理。");
            var flags = Marshal.PtrToStructure<Option>(options).Number;
            var server = Marshal.PtrToStructure<Option>(options + size).Text;
            var bypass = Marshal.PtrToStructure<Option>(options + size * 2).Text;
            try { return new(flags, Marshal.PtrToStringUni(server) ?? "", Marshal.PtrToStringUni(bypass) ?? ""); }
            finally { if (server != 0) GlobalFree(server); if (bypass != 0) GlobalFree(bypass); }
        }
        finally { Marshal.FreeHGlobal(listPointer); Marshal.FreeHGlobal(options); }
    }
    static void Apply(ProxyState state)
    {
        var size = Marshal.SizeOf<Option>(); var options = Marshal.AllocHGlobal(size * 3); var listPointer = Marshal.AllocHGlobal(Marshal.SizeOf<OptionList>());
        var server = Marshal.StringToHGlobalUni(state.Server); var bypass = Marshal.StringToHGlobalUni(state.Bypass);
        try
        {
            Marshal.StructureToPtr(new Option { Kind = 1, Number = state.Flags }, options, false);
            Marshal.StructureToPtr(new Option { Kind = 2, Text = server }, options + size, false);
            Marshal.StructureToPtr(new Option { Kind = 3, Text = bypass }, options + size * 2, false);
            var list = new OptionList { Size = Marshal.SizeOf<OptionList>(), Count = 3, Options = options }; Marshal.StructureToPtr(list, listPointer, false);
            if (!InternetSetOption(0, 75, listPointer, list.Size)) throw new ClientFailure("系统代理设置失败，可能受企业策略限制。");
            Notify();
        }
        finally { Marshal.FreeHGlobal(server); Marshal.FreeHGlobal(bypass); Marshal.FreeHGlobal(listPointer); Marshal.FreeHGlobal(options); }
    }
    static void Notify()
    {
        InternetSetOption(0, 39, 0, 0);
        InternetSetOption(0, 37, 0, 0);
    }
    public void Enable(int port)
    {
        if (NeedsRecovery) throw new ClientFailure("请先恢复上次保存的系统代理设置。");
        var previous = ReadCurrent();
        if ((previous.Flags & 4) != 0) throw new ClientFailure("当前启用了 PAC，请关闭系统代理接管，使用本地代理测试。");
        var expected = $"http=127.0.0.1:{port};https=127.0.0.1:{port};socks=127.0.0.1:{port}";
        var snapshot = new ProxySnapshot(owner, previous, expected);
        LocalStorage.WriteAtomic(recovery, JsonSerializer.Serialize(snapshot));
        try
        {
            Apply(new(3, expected, "<local>;127.*;localhost"));
        }
        catch { Restore(recovery, owner, true); throw new ClientFailure("系统代理设置失败，可能受企业策略限制。"); }
    }
    public void Restore(bool explicitRecovery = false) => Restore(recovery, explicitRecovery ? null : owner, explicitRecovery);
    public static void Restore(string path, string? expectedOwner, bool force)
    {
        if (!File.Exists(path)) return;
        var snapshot = JsonSerializer.Deserialize<ProxySnapshot>(File.ReadAllText(path)) ?? throw new ClientFailure("代理恢复记录无效。");
        if (expectedOwner is not null && snapshot.Owner != expectedOwner) return;
        var current = ReadCurrent();
        if (!force && ((current.Flags & 2) == 0 || current.Server != snapshot.Expected))
            throw new ClientFailure("系统代理已被其他程序修改，保留了恢复记录，请核对后恢复。");
        Apply(snapshot.Previous); File.Delete(path);
    }
}
