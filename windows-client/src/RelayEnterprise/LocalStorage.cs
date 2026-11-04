using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace RelayEnterprise;

public sealed record ClientSettings(string ServerAddress, string InstallationId);
public static class LocalStorage
{
    public static string DirectoryPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RelayEnterprise");
    public static void EnsurePrivateDirectory(string directory)
    {
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) return;
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        var inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(directory).SetAccessControl(security);
    }
    public static void WriteAtomic(string path, string value)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, value); File.Move(temporary, path, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public static ClientSettings Settings()
    {
        EnsurePrivateDirectory(DirectoryPath);
        try
        {
            var settings = JsonSerializer.Deserialize<ClientSettings>(File.ReadAllText(Path.Combine(DirectoryPath, "settings.json")));
            if (settings is not null && Guid.TryParse(settings.InstallationId, out _)) return settings;
        }
        catch { }
        var created = new ClientSettings("https://vpn-243359801139.asia-east1.run.app", Guid.NewGuid().ToString());
        SaveSettings(created); return created;
    }
    public static void SaveSettings(ClientSettings settings) => WriteAtomic(Path.Combine(DirectoryPath, "settings.json"), JsonSerializer.Serialize(settings));
}
