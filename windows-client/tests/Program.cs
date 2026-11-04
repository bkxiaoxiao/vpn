using RelayEnterprise;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

static class Tests
{
    static void Ensure(bool value, string reason) { if (!value) throw new Exception(reason); }
    static async Task Fails(Func<Task> action, string reason) { try { await action(); } catch { return; } throw new Exception(reason); }
    static Policy Sample(JsonArray nodes, DateTimeOffset? expires = null) => new(new JsonObject { ["authentication"] = "feishu", ["revision"] = 1, ["expiresAt"] = (expires ?? DateTimeOffset.UtcNow.AddMinutes(5)).ToString("O"), ["config"] = new JsonObject { ["outbounds"] = nodes } });
    public static async Task Main()
    {
        if (OperatingSystem.IsWindows()) { var currentProxy = SystemProxy.ReadCurrent(); Ensure(currentProxy.Flags >= 0, "WinINET proxy query"); Console.WriteLine("PASS read-only native Windows proxy API"); }
        var binding = ProtocolSecurity.CreateBinding();
        Ensure(binding.Verifier.Length == 43 && binding.Challenge == ProtocolSecurity.Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(binding.Verifier))), "PKCE binding");
        Ensure(binding != ProtocolSecurity.CreateBinding(), "Fresh randomness");
        foreach (var address in new[] { "https://example.com/path", "https://user:pass@example.com", "http://example.com", "https://example.com/?token=secret", "https://example.com/#x" })
            await Fails(() => Task.FromResult(ProtocolSecurity.ServiceAddress(address)), "Unsafe service address accepted");
        var service = ProtocolSecurity.ServiceAddress("https://example.com");
        Ensure(ProtocolSecurity.IsAuthorizationAddress(service, "https://example.com/auth/desktop/start?state=test-only"), "Authorization address");
        Ensure(!ProtocolSecurity.IsAuthorizationAddress(service, "https://other.example.com/auth/desktop/start"), "Foreign authorization host");
        Console.WriteLine("PASS PKCE randomness and enterprise origin validation");

        var opened = new List<Uri>(); var browser = new BrowserLogin(uri => { opened.Add(uri); return true; });
        var callback = new Uri("relay-enterprise://auth/callback?transaction=expected&ticket=test-only-ticket-123456");
        Ensure(!browser.Accept(callback), "Unsolicited callback");
        var pending = browser.Begin(new("https://example.com/auth/desktop/start?state=test-only"), "expected", CancellationToken.None);
        foreach (var invalid in new[] {
            "https://auth/callback?transaction=expected&ticket=test-only-ticket-123456",
            "relay-enterprise://auth/callback?transaction=other&ticket=test-only-ticket-123456",
            "relay-enterprise://auth/callback?transaction=expected&transaction=expected&ticket=test-only-ticket-123456",
            "relay-enterprise://auth/callback?transaction=expected&ticket=short",
            "relay-enterprise://auth/callback?transaction=expected&ticket=test-only-ticket-123456#bad"
        }) Ensure(!browser.Accept(new(invalid)), "Invalid callback");
        Ensure(browser.Reopen() && opened.Count == 2, "Reopen browser");
        Ensure(browser.Accept(callback) && !browser.Accept(callback) && await pending == callback, "One-shot matching callback");
        var cancelled = browser.Begin(service, "expected", CancellationToken.None); browser.Cancel();
        await Fails(async () => await cancelled, "Cancel did not release login");
        await Fails(async () => await browser.Begin(service, "expected", CancellationToken.None, TimeSpan.FromMilliseconds(5)), "Timeout did not release login");
        await Fails(async () => await new BrowserLogin(_ => false).Begin(service, "expected", CancellationToken.None), "Browser launch failure");
        Console.WriteLine("PASS callback binding, one-shot use, cancellation, timeout and reopen");

        var time = DateTimeOffset.UtcNow;
        Ensure(!ProtocolSecurity.NeedsLatencyRefresh(time, time.AddSeconds(3599)) && ProtocolSecurity.NeedsLatencyRefresh(time, time.AddHours(1)) && ProtocolSecurity.NeedsLatencyRefresh(time, time.AddSeconds(-1)), "Hourly cache");
        Ensure(new ClientFailure("没有获授权的已发布节点", 403).PolicyUnavailable && !new ClientFailure("员工未授权", 403).PolicyUnavailable, "No policy versus revoked access");
        await Fails(() => Task.FromResult(Sample(new JsonArray(), time.AddSeconds(-1))), "Expired policy accepted");
        Console.WriteLine("PASS hourly cache and strict policy/authorization boundaries");

        var corePath = Environment.GetEnvironmentVariable("RELAY_TEST_CORE") ?? (OperatingSystem.IsWindows() ? Path.GetFullPath(".tools/sing-box.exe") : "/opt/homebrew/bin/sing-box");
        var python = Environment.GetEnvironmentVariable("RELAY_TEST_PYTHON") ?? (OperatingSystem.IsWindows() ? "python" : "python3");
        var fixtureInfo = new ProcessStartInfo(python) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        fixtureInfo.ArgumentList.Add(Path.GetFullPath("../mac-client/Tests/core-fixture.py"));
        using var fixture = Process.Start(fixtureInfo) ?? throw new Exception("Fixture not started");
        var directory = Path.Combine(Path.GetTempPath(), "relay-windows-tests-" + Guid.NewGuid().ToString("N"));
        LocalStorage.EnsurePrivateDirectory(directory);
        try
        {
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var line = await fixture.StandardOutput.ReadLineAsync(startup.Token) ?? throw new Exception("Fixture missing ports");
            var ports = JsonSerializer.Deserialize<Dictionary<string, int>>(line)!;
            var tags = new[] { "测试 / A ?#%", "测试 B", "不可达" };
            var nodes = new JsonArray(tags.Zip(new[] { ports["a"], ports["b"], ports["unavailable"] }).Select(p => (JsonNode)new JsonObject { ["type"] = "http", ["tag"] = p.First, ["server"] = "127.0.0.1", ["server_port"] = p.Second }).ToArray());
            var policy = Sample(nodes);
            using var core = new CoreEngine(directory, corePath);
            await core.Start(policy, tags[0], CancellationToken.None);
            var port = core.Port; var run = core.RunId;
            async Task<string> Traffic()
            {
                using var http = new HttpClient(new HttpClientHandler { Proxy = new WebProxy($"http://127.0.0.1:{port}"), UseProxy = true }) { Timeout = TimeSpan.FromSeconds(5) };
                return await http.GetStringAsync("http://relay.test.invalid/check");
            }
            Ensure(await Traffic() == "route-a", "Initial route not used");
            await core.Select(tags[1], CancellationToken.None);
            Ensure(await Traffic() == "route-b" && core.Port == port && core.RunId == run, "Hot switch did not preserve core/port");
            await Fails(() => core.Select("unauthorized", CancellationToken.None), "Unauthorized route accepted");
            Console.WriteLine("PASS real core hot switch routes actual traffic and preserves port");
            var file = Path.Combine(directory, "core-run.json"); var config = JsonNode.Parse(File.ReadAllText(file))!;
            var control = config["experimental"]!["clash_api"]!;
            Ensure(control["external_controller"]!.GetValue<string>().StartsWith("127.0.0.1:"), "Public control binding");
            var controlPort = int.Parse(control["external_controller"]!.GetValue<string>().Split(':')[1]);
            using var wrong = new CoreController(controlPort, "wrong-secret", config["route"]!["final"]!.GetValue<string>());
            await Fails(async () => await wrong.Selected(), "Controller accepted wrong secret");
            var target = new Uri("https://www.apple.com/library/test/success.html");
            foreach (var tag in tags.Take(2)) Ensure(await core.Latency(tag, CancellationToken.None, target) is >= 35, "Per-route HTTPS probe failed");
            Ensure(await core.Latency(tags[2], CancellationToken.None, target) is null && await core.Selected(CancellationToken.None) == tags[1], "Probe changed active route or fabricated latency");
            core.Renew(Sample((JsonArray)nodes.DeepClone(), DateTimeOffset.UtcNow.AddMinutes(10)));
            Ensure(core.RunId == run, "Lease refresh restarted core");
            core.Stop(); Ensure(!File.Exists(file) && core.RunId is null && core.Port == 0, "Stop left credentials/control state");
            Console.WriteLine("PASS controller authentication, HTTPS latency, selection isolation and cleanup");
        }
        finally
        {
            try { if (!fixture.HasExited) fixture.Kill(true); await fixture.WaitForExitAsync(); } catch { }
            try { Directory.Delete(directory, true); } catch { }
        }
    }
}
