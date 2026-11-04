using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace RelayEnterprise;

public sealed class CoreController(int port, string secret, string selector) : IDisposable
{
    readonly HttpClient client = new(new HttpClientHandler { UseProxy = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(9) };
    async Task<JsonObject?> Request(string route, string? selection, Uri? target, CancellationToken cancellation)
    {
        var path = $"http://127.0.0.1:{port}/proxies/{Uri.EscapeDataString(route)}";
        if (target is not null) path += "/delay?url=" + Uri.EscapeDataString(target.AbsoluteUri) + "&timeout=5000";
        using var request = new HttpRequestMessage(selection is null ? HttpMethod.Get : HttpMethod.Put, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        if (selection is not null) request.Content = JsonContent.Create(new { name = selection });
        using var response = await client.SendAsync(request, cancellation);
        if (!response.IsSuccessStatusCode) throw new ClientFailure("本地线路控制请求未成功。");
        if (selection is not null) return null;
        return JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellation)) as JsonObject ?? throw new ClientFailure("本地线路响应无效。");
    }
    public async Task<string> Selected(CancellationToken cancellation = default) =>
        (await Request(selector, null, null, cancellation))?["now"]?.GetValue<string>() ?? throw new ClientFailure("无法确认当前线路。");
    public async Task Select(string route, CancellationToken cancellation)
    {
        await Request(selector, route, null, cancellation);
        if (await Selected(cancellation) != route) throw new ClientFailure("线路切换结果未确认。");
    }
    public async Task<int?> Latency(string route, CancellationToken cancellation, Uri? target = null)
    {
        try
        {
            var data = await Request(route, null, target ?? new Uri("https://www.gstatic.com/generate_204"), cancellation);
            return data?["delay"] is JsonValue value && value.TryGetValue<int>(out var ms) && ms is >= 0 and <= 65535 ? ms : null;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch { return null; }
    }
    public void Dispose() => client.Dispose();
}
