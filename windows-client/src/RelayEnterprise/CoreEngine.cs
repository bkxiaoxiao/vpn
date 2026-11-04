using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace RelayEnterprise;

public sealed class CoreEngine(string directory, string? corePath = null) : IDisposable
{
    sealed record Runtime(Guid Id, CoreController Control, IReadOnlyList<string> Routes, int Revision, DateTimeOffset Expires);
    Process? process;
    Runtime? runtime;
    long lifecycle;
    CoreJob? job;
    public event Action? UnexpectedExit;
    public int Port { get; private set; }
    public Guid? RunId => runtime?.Id;
    public bool Running => process is { HasExited: false };
    public int ProcessId => process?.Id ?? 0;
    public long StartTicks => process?.StartTime.ToUniversalTime().Ticks ?? 0;
    readonly string file = Path.Combine(directory, "core-run.json");
    static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port;
    }
    public async Task Start(Policy policy, string selected, CancellationToken cancellation)
    {
        Stop();
        var epoch = lifecycle;
        if (policy.Expires <= DateTimeOffset.UtcNow || !policy.Routes.Contains(selected)) throw new ClientFailure("授权线路已失效，请重新同步。");
        var core = corePath ?? Path.Combine(AppContext.BaseDirectory, "core", "sing-box.exe");
        if (!File.Exists(core)) throw new ClientFailure("安装包缺少代理核心，请重新安装。");
        Port = FreePort(); var controlPort = FreePort(); while (controlPort == Port) controlPort = FreePort();
        var selector = "relay-active-" + Guid.NewGuid().ToString("N");
        var secret = ProtocolSecurity.Base64Url(RandomNumberGenerator.GetBytes(32));
        var controller = new CoreController(controlPort, secret, selector);
        var outbounds = (JsonArray)policy.Outbounds.DeepClone();
        outbounds.Add(new JsonObject { ["type"] = "selector", ["tag"] = selector, ["outbounds"] = new JsonArray(policy.Routes.Select(r => JsonValue.Create(r)).ToArray()), ["default"] = selected, ["interrupt_exist_connections"] = true });
        var config = new JsonObject
        {
            ["log"] = new JsonObject { ["disabled"] = true },
            ["inbounds"] = new JsonArray(new JsonObject { ["type"] = "mixed", ["tag"] = "relay-local", ["listen"] = "127.0.0.1", ["listen_port"] = Port }),
            ["outbounds"] = outbounds,
            ["route"] = new JsonObject { ["final"] = selector },
            ["experimental"] = new JsonObject { ["clash_api"] = new JsonObject { ["external_controller"] = $"127.0.0.1:{controlPort}", ["secret"] = secret, ["access_control_allow_origin"] = new JsonArray("http://127.0.0.1"), ["access_control_allow_private_network"] = false } }
        };
        LocalStorage.WriteAtomic(file, config.ToJsonString());
        try
        {
            var checkInfo = Info(core, "check", "-c", file);
            using (var check = Process.Start(checkInfo) ?? throw new ClientFailure("无法校验代理核心。"))
            {
                var output = check.StandardOutput.ReadToEndAsync(cancellation); var error = check.StandardError.ReadToEndAsync(cancellation);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(10));
                try { await check.WaitForExitAsync(timeout.Token); } catch { if (!check.HasExited) check.Kill(true); throw; }
                await Task.WhenAll(output, error);
                if (check.ExitCode != 0) throw new ClientFailure("线路配置未通过核心校验，请联系管理员。");
            }
            cancellation.ThrowIfCancellationRequested();
            if (lifecycle != epoch) throw new OperationCanceledException();
            var run = new Runtime(Guid.NewGuid(), controller, policy.Routes, policy.Revision, policy.Expires);
            var started = new Process { StartInfo = Info(core, "run", "-c", file), EnableRaisingEvents = true };
            started.Exited += (_, _) => { if (runtime?.Id == run.Id) UnexpectedExit?.Invoke(); };
            process = started; runtime = run;
            job = CoreJob.Create();
            if (!started.Start()) throw new ClientFailure("无法启动代理核心。");
            job?.Attach(started);
            _ = Drain(started.StandardOutput); _ = Drain(started.StandardError);
            await Task.Delay(700, cancellation);
            if (runtime?.Id != run.Id || !Running || await controller.Selected(cancellation) != selected || lifecycle != epoch) throw new ClientFailure("代理核心控制接口未能启动。");
        }
        catch { controller.Dispose(); if (lifecycle == epoch) Stop(); throw; }
    }
    static ProcessStartInfo Info(string executable, params string[] arguments)
    {
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return info;
    }
    static async Task Drain(StreamReader reader) { try { while (await reader.ReadLineAsync() is not null) { } } catch { } }
    Runtime Require(string? route = null)
    {
        var run = runtime;
        if (run is null || !Running || run.Expires <= DateTimeOffset.UtcNow || (route is not null && !run.Routes.Contains(route))) throw new ClientFailure("运行线路已失效，请重新同步。");
        return run;
    }
    public async Task Select(string route, CancellationToken cancellation)
    {
        var run = Require(route); await run.Control.Select(route, cancellation);
        if (runtime?.Id != run.Id || !Running) throw new ClientFailure("连接已结束。");
    }
    public async Task<string> Selected(CancellationToken cancellation)
    {
        var run = Require(); var selected = await run.Control.Selected(cancellation);
        if (runtime?.Id != run.Id || !run.Routes.Contains(selected)) throw new ClientFailure("无法确认当前已授权线路。");
        return selected;
    }
    public Task<int?> Latency(string route, CancellationToken cancellation, Uri? target = null)
    {
        var run = Require(route); return run.Control.Latency(route, cancellation, target);
    }
    public void Renew(Policy policy)
    {
        var run = runtime;
        if (run is null || !Running || run.Revision != policy.Revision || !run.Routes.SequenceEqual(policy.Routes) || policy.Expires <= DateTimeOffset.UtcNow) throw new ClientFailure("运行配置已变更，请重新连接。");
        runtime = run with { Expires = policy.Expires };
    }
    public void Stop()
    {
        lifecycle++;
        var old = process; process = null; var previous = runtime; runtime = null; Port = 0;
        if (old is not null) { try { if (!old.HasExited) old.Kill(true); } catch { } old.Dispose(); }
        job?.Dispose(); job = null;
        previous?.Control.Dispose();
        try { File.Delete(file); } catch { }
    }
    public void Dispose() => Stop();
}
