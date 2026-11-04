using System.ComponentModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace RelayEnterprise;

public sealed class ClientFailure(string message, int status = 0) : Exception(message)
{
    public int Status { get; } = status;
    public bool PolicyUnavailable => Status == 409 || (Status == 403 && Message == "没有获授权的已发布节点");
}
public sealed record AuthStart(string AuthorizationURL, string TransactionId);
public sealed record AuthResult(string Token, string DeviceId, string Name, string Authentication, string ExpiresAt);
public sealed record SessionStatus(string Authentication, string Name, string ExpiresAt, string DeviceId);

public sealed class Policy
{
    public int Revision { get; }
    public DateTimeOffset Expires { get; }
    public JsonArray Outbounds { get; }
    public IReadOnlyList<string> Routes { get; }
    public string Metering { get; }
    public Policy(JsonObject data)
    {
        if (data["authentication"]?.GetValue<string>() != "feishu" || data["revision"] is not JsonValue revision ||
            !revision.TryGetValue<int>(out var number) || number < 1 ||
            !DateTimeOffset.TryParse(data["expiresAt"]?.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var expires) || expires <= DateTimeOffset.UtcNow ||
            data["config"]?["outbounds"] is not JsonArray outbounds)
            throw new ClientFailure("未获得有效的飞书授权配置", 403);
        var routes = outbounds.OfType<JsonObject>()
            .Where(o => o["type"]?.GetValue<string>() is not ("selector" or "direct" or "block"))
            .Select(o => o["tag"]?.GetValue<string>()).Where(s => !string.IsNullOrWhiteSpace(s)).Cast<string>().ToArray();
        if (routes.Length == 0 || routes.Distinct(StringComparer.Ordinal).Count() != routes.Length)
            throw new ClientFailure("管理员尚未分配可用线路", 409);
        Revision = number; Expires = expires; Outbounds = (JsonArray)outbounds.DeepClone(); Routes = routes;
        Metering = data["metering"]?.GetValue<string>() ?? "unmetered";
    }
}
public static class ProtocolSecurity
{
    public static readonly TimeSpan LatencyInterval = TimeSpan.FromHours(1);
    public static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static (string Verifier, string Challenge) CreateBinding()
    {
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        return (verifier, Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(verifier))));
    }
    public static Uri ServiceAddress(string address)
    {
        if (!Uri.TryCreate(address.Trim(), UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/" ||
            (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)))
            throw new ClientFailure("请输入 HTTPS 企业服务地址；本机测试只允许回环 HTTP 地址。");
        return uri;
    }
    public static bool IsAuthorizationAddress(Uri service, string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == service.Scheme && uri.Host == service.Host &&
        uri.Port == service.Port && uri.AbsolutePath == "/auth/desktop/start" && string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Fragment);
    public static bool NeedsLatencyRefresh(DateTimeOffset? updated, DateTimeOffset now) =>
        updated is null || now < updated || now - updated >= LatencyInterval;
    public static (string Ticket, string Transaction)? Callback(Uri uri, string expected)
    {
        if (uri.Scheme != "relay-enterprise" || uri.Host != "auth" || uri.AbsolutePath != "/callback" ||
            !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort || !string.IsNullOrEmpty(uri.Fragment)) return null;
        var pairs = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
        if (pairs.Length != 2) return null;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in pairs)
        {
            var parts = pair.Split('=', 2);
            if (parts.Length != 2 || !values.TryAdd(Uri.UnescapeDataString(parts[0]), Uri.UnescapeDataString(parts[1]))) return null;
        }
        if (!values.TryGetValue("transaction", out var transaction) || transaction != expected ||
            !values.TryGetValue("ticket", out var ticket) || ticket.Length is < 16 or > 200 ||
            ticket.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('_' or '-'))) return null;
        return (ticket, transaction);
    }
}
public sealed class RouteView(string tag) : INotifyPropertyChanged
{
    public string Tag { get; } = tag;
    string latency = "未检测";
    public string Label => $"{Tag.Split(" · ")[0]} · {latency}";
    public void SetLatency(int? milliseconds, bool pending = false)
    {
        latency = pending ? "检测中…" : milliseconds is int ms ? $"{ms} ms" : "超时/不可达";
        PropertyChanged?.Invoke(this, new(nameof(Label)));
    }
    public event PropertyChangedEventHandler? PropertyChanged;
}
