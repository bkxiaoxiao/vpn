using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace RelayEnterprise;

public static class ApplicationCatalog
{
    public static LocalApplication FromPath(string path, string? name = null)
    {
        path = Environment.ExpandEnvironmentVariables(path);
        if (!Path.IsPathFullyQualified(path)) throw new ClientFailure("应用路径必须是本机完整路径。");
        path = Path.GetFullPath(path);
        if (!Path.IsPathFullyQualified(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
            throw new ClientFailure("请选择本机已安装的 .exe 可执行文件。");
        return new(name ?? Path.GetFileNameWithoutExtension(path), path);
    }
    public static IReadOnlyList<LocalApplication> Scan()
    {
        var apps = new Dictionary<string, LocalApplication>(StringComparer.OrdinalIgnoreCase);
        void Add(string path, string? name) { try { var app = FromPath(path, name); apps.TryAdd(app.Path, app); } catch { } }
        if (!OperatingSystem.IsWindows()) return [];
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try {
                using var root = RegistryKey.OpenBaseKey(hive, view);
                using var uninstall = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall");
                foreach (var key in uninstall?.GetSubKeyNames() ?? []) {
                    using var app = uninstall!.OpenSubKey(key);
                    if (app?.GetValue("DisplayName") is not string name || app.GetValue("DisplayIcon") is not string icon) continue;
                    icon = icon.Trim();
                    if (icon.StartsWith('"')) { var end = icon.IndexOf('"', 1); if (end < 0) continue; icon = icon[1..end]; }
                    else { var end = icon.LastIndexOf(','); if (end >= 0 && int.TryParse(icon[(end + 1)..].Trim(), out _)) icon = icon[..end]; }
                    Add(icon.Trim(), name);
                }
            } catch { }
        }
        object? shell = null;
        try {
            var type = Type.GetTypeFromProgID("WScript.Shell"); if (type is null) return apps.Values.ToArray();
            shell = Activator.CreateInstance(type);
            foreach (var directory in new[] { Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), Environment.GetFolderPath(Environment.SpecialFolder.Programs) }) {
                if (!Directory.Exists(directory)) continue;
                foreach (var link in Directory.EnumerateFiles(directory, "*.lnk", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint })) {
                    object? shortcut = null;
                    try { shortcut = ((dynamic)shell!).CreateShortcut(link); Add((string)((dynamic)shortcut).TargetPath, Path.GetFileNameWithoutExtension(link)); }
                    catch { } finally { if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut); }
                }
            }
        } catch { } finally { if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell); }
        return apps.Values.OrderBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
    }
}
