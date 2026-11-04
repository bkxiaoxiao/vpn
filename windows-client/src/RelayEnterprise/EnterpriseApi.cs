using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RelayEnterprise;

public sealed class EnterpriseApi : IDisposable
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public Uri Base { get; }
    readonly HttpClient client;
    public EnterpriseApi(string address)
    {
        Base = ProtocolSecurity.ServiceAddress(address);
        client = new(new HttpClientHandler { UseProxy = false, UseCookies = false }) { BaseAddress = Base, Timeout = TimeSpan.FromSeconds(25) };
    }
    public async Task<JsonObject> Request(string path, string? token = null, object? body = null, CancellationToken cancellation = default)
    {
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        using var response = await client.SendAsync(request, cancellation);
        var text = await response.Content.ReadAsStringAsync(cancellation);
        JsonObject? data;
        try { data = JsonNode.Parse(text) as JsonObject; } catch { data = null; }
        if (!response.IsSuccessStatusCode) throw new ClientFailure(data?["error"]?.GetValue<string>() ?? "企业服务请求失败，请重试。", (int)response.StatusCode);
        return data ?? throw new ClientFailure("企业服务返回了无效数据。");
    }
    public async Task<AuthStart> Start(string challenge, string installationId, CancellationToken cancellation)
    {
        var data = await Request("/api/desktop/auth/start", body: new { challenge, installationId, deviceName = Environment.MachineName[..Math.Min(90, Environment.MachineName.Length)], platform = "Windows" }, cancellation: cancellation);
        var result = data.Deserialize<AuthStart>(Json) ?? throw new ClientFailure("登录参数无效。");
        if (!ProtocolSecurity.IsAuthorizationAddress(Base, result.AuthorizationURL) || string.IsNullOrEmpty(result.TransactionId)) throw new ClientFailure("登录地址与企业服务不匹配。", 403);
        return result;
    }
    public async Task<AuthResult> Exchange(string ticket, string verifier, string transactionId, CancellationToken cancellation)
    {
        var data = await Request("/api/desktop/auth/exchange", body: new { ticket, verifier, transactionId }, cancellation: cancellation);
        var result = data.Deserialize<AuthResult>(Json) ?? throw new ClientFailure("登录凭证无效。", 403);
        if (result.Authentication != "feishu" || !DateTimeOffset.TryParse(result.ExpiresAt, out var until) || until <= DateTimeOffset.UtcNow) throw new ClientFailure("飞书登录凭证无效。", 403);
        return result;
    }
    public async Task<SessionStatus> Status(string token, CancellationToken cancellation) =>
        (await Request("/api/client/status", token, cancellation: cancellation)).Deserialize<SessionStatus>(Json) ?? throw new ClientFailure("飞书认证无效。", 403);
    public async Task<Policy> Policy(string token, CancellationToken cancellation) => new(await Request("/api/client/policy", token, cancellation: cancellation));
    public Task<JsonObject> Ack(Policy policy, string stage, string token, CancellationToken cancellation) => Request("/api/client/ack", token, new { revision = policy.Revision, stage }, cancellation);
    public void Dispose() => client.Dispose();
}
