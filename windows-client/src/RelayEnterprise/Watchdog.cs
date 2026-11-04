using System.Diagnostics;
using System.IO;

namespace RelayEnterprise;

public static class Watchdog
{
    public static void Start(CoreEngine core, SystemProxy proxy)
    {
        var executable = Environment.ProcessPath ?? throw new ClientFailure("无法创建核心看护进程。");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "--watchdog", Environment.ProcessId.ToString(), Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(), core.ProcessId.ToString(), core.StartTicks.ToString(), proxy.Owner }) info.ArgumentList.Add(argument);
        using var started = Process.Start(info) ?? throw new ClientFailure("无法创建核心看护进程。");
    }
    public static async Task Run(string[] args)
    {
        if (args.Length != 6 || !int.TryParse(args[1], out var parentPid) || !long.TryParse(args[2], out var parentTicks) ||
            !int.TryParse(args[3], out var corePid) || !long.TryParse(args[4], out var coreTicks) || !Guid.TryParseExact(args[5], "N", out _)) return;
        try
        {
            using var parent = Process.GetProcessById(parentPid);
            if (parent.StartTime.ToUniversalTime().Ticks == parentTicks) await parent.WaitForExitAsync();
        }
        catch { }
        try { using var core = Process.GetProcessById(corePid); if (core.StartTime.ToUniversalTime().Ticks == coreTicks && string.Equals(core.MainModule?.FileName, Path.Combine(AppContext.BaseDirectory, "core", "sing-box.exe"), StringComparison.OrdinalIgnoreCase) && !core.HasExited) core.Kill(true); } catch { }
        try { SystemProxy.Restore(Path.Combine(LocalStorage.DirectoryPath, "proxy-recovery.json"), args[5], false); } catch { }
    }
}
