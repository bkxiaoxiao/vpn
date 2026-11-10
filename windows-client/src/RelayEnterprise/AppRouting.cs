using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RelayEnterprise;

public sealed record LocalApplication(string Name, string Path)
{
    public string Pattern(bool windows) => (windows ? "(?i)" : "") + "^" + Escape(Path) + "$";
    public static string Escape(string path)
    {
        var result = new StringBuilder();
        foreach (var c in path) { if ("\\.+*?[^]$(){}|".Contains(c)) result.Append('\\'); result.Append(c); }
        return result.ToString();
    }
}
public sealed record AppRoutingSettings(string Mode, LocalApplication[] Applications)
{
    public static AppRoutingSettings Default => new("all", []);
    public string Summary => (Mode switch { "include" => "仅所选应用走代理", "exclude" => "所选应用不走代理", _ => "全部应用" }) + (Mode == "all" ? "" : $" · {Applications.Length} 个");
    public AppRoutingSettings Validate()
    {
        if (Mode is not ("all" or "include" or "exclude") || Applications is null || Applications.Length > 500
            || Applications.Any(a => a is null || string.IsNullOrWhiteSpace(a.Name) || a.Path is null || a.Path.Length > 4096 || a.Path.Contains('\0') || !Path.IsPathFullyQualified(a.Path))
            || Applications.Select(a => a.Path).Distinct(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal).Count() != Applications.Length)
            throw new ClientFailure("应用分流设置无效，请重新选择应用并保存。");
        return this;
    }
    public JsonObject Route(string selector, string direct)
    {
        Validate();
        if (Mode == "all") return new() { ["final"] = selector };
        if (Mode == "include" && Applications.Length == 0) throw new ClientFailure("请先选择至少一个需要走代理的应用。");
        var rules = new JsonArray();
        if (Applications.Length > 0) rules.Add(new JsonObject { ["process_path_regex"] = new JsonArray(Applications.Select(a => JsonValue.Create(a.Pattern(OperatingSystem.IsWindows()))).ToArray()), ["action"] = "route", ["outbound"] = Mode == "include" ? selector : direct });
        if (Mode == "exclude") rules.Add(new JsonObject { ["process_path_regex"] = new JsonArray(".+"), ["action"] = "route", ["outbound"] = selector });
        return new() { ["rules"] = rules, ["final"] = direct, ["find_process"] = true };
    }
    public static AppRoutingSettings Load(string directory, out string? error)
    {
        error = null; var file = Path.Combine(directory, "app-routing.json");
        if (!File.Exists(file)) return Default;
        try { return (JsonSerializer.Deserialize<AppRoutingSettings>(File.ReadAllText(file)) ?? throw new JsonException()).Validate(); }
        catch { error = "无法读取应用分流设置，请重新选择并保存后连接。"; return Default; }
    }
    public void Save(string directory) { Validate(); LocalStorage.WriteAtomic(Path.Combine(directory, "app-routing.json"), JsonSerializer.Serialize(this)); }
}
