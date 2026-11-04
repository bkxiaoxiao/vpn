using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;

namespace RelayEnterprise;

public sealed class ClientModel : INotifyPropertyChanged
{
    readonly CoreEngine core;
    readonly SystemProxy proxy;
    readonly BrowserLogin browser;
    readonly ClientSettings settings;
    EnterpriseApi? api;
    string? token;
    DateTimeOffset sessionExpires;
    Policy? policy;
    string? activeRoute;
    CancellationTokenSource? action;
    CancellationTokenSource? probes;
    Guid generation = Guid.NewGuid();
    DateTimeOffset? lastSync;
    DateTimeOffset? lastLatency;
    bool maintenanceRunning;
    bool protocolReady = true;
    string address;
    RouteView? selected;
    public event PropertyChangedEventHandler? PropertyChanged;
    public ObservableCollection<RouteView> Routes { get; } = [];
    public string ServerAddress { get => address; set { address = value; Changed(); } }
    public RouteView? SelectedRoute { get => selected; set { selected = value; Changed(); } }
    public bool UseSystemProxy { get; set; } = true;
    public bool IsAuthenticated { get; private set; }
    public bool IsConnected { get; private set; }
    public bool Busy { get; private set; }
    public bool WaitingBrowser { get; private set; }
    public bool MeasuringLatency { get; private set; }
    public string Name { get; private set; } = "未登录";
    public string Message { get; private set; } = "请先通过飞书登录，才能同步企业配置与连接。";
    public string AuthLabel => IsAuthenticated ? "✓ 已通过飞书认证" : "🔒 飞书登录保护";
    public string Headline => IsConnected ? "连接已就绪" : "安全连接，从身份开始。";
    public string LoginLabel => WaitingBrowser ? "重新打开飞书" : Busy ? "正在验证…" : "通过飞书登录";
    public string LoginStep => IsAuthenticated ? "✓ 飞书登录" : "1  飞书登录";
    public string SyncStep => policy is not null ? "✓ 同步配置" : "2  同步配置";
    public string ConnectStep => IsConnected ? "✓ 连接使用" : "3  连接使用";
    public string RevisionLabel => policy is null ? "" : $"配置 v{policy.Revision}";
    public string LatencyLabel => MeasuringLatency ? "正在检测线路延迟…" : lastLatency is { } at ? $"延迟更新于 {at.ToLocalTime():HH:mm} · 每小时更新" : "首次连接后检测延迟，每小时更新";
    public string MeteringLabel => policy?.Metering == "gateway" ? "企业网关计量模式" : "外购节点直连 · 不包含企业网关用量统计";
    public string PortLabel => IsConnected ? $"本地代理 127.0.0.1:{core.Port} · 每 30 秒校验授权" : "";
    public bool HasRoutes => IsAuthenticated && Routes.Count > 0;
    public bool EmptyRoutes => !HasRoutes;
    public bool ShowLogin => !IsAuthenticated;
    public bool CanLogin => protocolReady && !IsAuthenticated && (!Busy || WaitingBrowser);
    public bool CanCancel => Busy && !IsAuthenticated;
    public bool CanSync => IsAuthenticated && !Busy && !IsConnected;
    public bool CanConnect => IsAuthenticated && policy is not null && !Busy && !IsConnected && !proxy.NeedsRecovery;
    public bool CanEditAddress => !IsAuthenticated && !Busy;
    public bool CanPickRoute => HasRoutes && !Busy;
    public bool CanEditProxy => !IsConnected && !Busy;
    public bool ShowRecovery => proxy.NeedsRecovery && !IsConnected;
    public ClientModel(Action<Action> dispatch)
    {
        settings = LocalStorage.Settings(); address = settings.ServerAddress;
        try { System.IO.File.Delete(System.IO.Path.Combine(LocalStorage.DirectoryPath, "core-run.json")); } catch { }
        core = new(LocalStorage.DirectoryPath); proxy = new(LocalStorage.DirectoryPath);
        browser = new(uri => { try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); return true; } catch { return false; } });
        core.UnexpectedExit += () => { var run = core.RunId; dispatch(() => { if (IsConnected && core.RunId == run) Lock("代理核心已停止，请重新登录后连接。"); }); };
        if (proxy.NeedsRecovery) Message = "发现上次的代理恢复记录，请先恢复系统代理，再连接。";
    }
    void Changed() => PropertyChanged?.Invoke(this, new(string.Empty));
    void Say(string text) { Message = text; Changed(); }
    static string Friendly(Exception error) => error is ClientFailure ? error.Message : error is OperationCanceledException ? "操作已取消或请求超时，请重试。" : "操作未完成，请检查网络或联系管理员。";
    public void ConfigurationError() { protocolReady = false; Say("无法注册登录回调，请重新运行安装程序后重试。"); }
    public bool AcceptCallback(Uri uri) => WaitingBrowser && browser.Accept(uri);
    public void Reopen() { if (WaitingBrowser) Say(browser.Reopen() ? "已重新打开默认浏览器，请完成飞书认证并允许返回 Relay。" : "无法打开默认浏览器，请取消后重试。"); }
    public void CancelLogin() { if (Busy && !IsAuthenticated) Lock("已取消飞书登录，可以重新发起。"); }
    public async Task Login()
    {
        if (IsAuthenticated || Busy || !protocolReady) return;
        var epoch = generation = Guid.NewGuid(); using var cancellation = new CancellationTokenSource(); action = cancellation;
        Busy = true; Say("正在向企业服务申请飞书登录…"); EnterpriseApi? service = null;
        try
        {
            service = new(ServerAddress); var binding = ProtocolSecurity.CreateBinding();
            var start = await service.Start(binding.Challenge, settings.InstallationId, cancellation.Token);
            if (generation != epoch) return;
            LocalStorage.SaveSettings(settings with { ServerAddress = service.Base.AbsoluteUri });
            WaitingBrowser = true; Say("已在默认浏览器打开飞书登录。完成后会返回客户端。");
            var callback = await browser.Begin(new(start.AuthorizationURL), start.TransactionId, cancellation.Token);
            if (generation != epoch) return;
            WaitingBrowser = false; Changed();
            var grant = ProtocolSecurity.Callback(callback, start.TransactionId) ?? throw new ClientFailure("登录回调不匹配。", 403);
            var result = await service.Exchange(grant.Ticket, binding.Verifier, start.TransactionId, cancellation.Token);
            if (generation != epoch) return;
            api = service; token = result.Token; sessionExpires = DateTimeOffset.Parse(result.ExpiresAt); Name = result.Name; IsAuthenticated = true;
            Say("飞书登录成功，正在同步企业配置…");
            await Synchronize(epoch, cancellation.Token);
        }
        catch (Exception error) { if (generation == epoch && !WaitForPolicy(error)) Lock(Friendly(error)); }
        finally
        {
            if (!ReferenceEquals(api, service)) service?.Dispose();
            if (ReferenceEquals(action, cancellation)) action = null;
            if (generation == epoch) { Busy = false; Changed(); }
        }
    }
    async Task<(EnterpriseApi Api, string Token)> Authorize(CancellationToken cancellation)
    {
        if (!IsAuthenticated || token is null || api is null || sessionExpires <= DateTimeOffset.UtcNow) throw new ClientFailure("请重新通过飞书登录。", 401);
        var service = api; var bearer = token; var status = await service.Status(bearer, cancellation);
        if (status.Authentication != "feishu" || !DateTimeOffset.TryParse(status.ExpiresAt, out var expires) || expires <= DateTimeOffset.UtcNow) throw new ClientFailure("飞书认证已失效。", 403);
        return (service, bearer);
    }
    async Task Synchronize(Guid epoch, CancellationToken cancellation)
    {
        var (service, bearer) = await Authorize(cancellation); var next = await service.Policy(bearer, cancellation);
        if (generation != epoch) return;
        var changed = policy?.Revision != next.Revision || !Routes.Select(r => r.Tag).SequenceEqual(next.Routes);
        if (changed)
        {
            if (IsConnected) Disconnect();
            CancelProbes(); lastLatency = null;
            var previous = SelectedRoute?.Tag;
            Routes.Clear(); foreach (var route in next.Routes) Routes.Add(new(route));
            SelectedRoute = Routes.FirstOrDefault(r => r.Tag == previous) ?? Routes[0];
        }
        policy = next; lastSync = DateTimeOffset.UtcNow;
        if (IsConnected) core.Renew(next);
        await service.Ack(next, IsConnected ? "applied" : "validated", bearer, cancellation);
        if (generation == epoch) Say(IsConnected ? "连接正常，飞书授权已校验。" : $"配置 v{next.Revision} 已同步，可以连接。");
    }
    public async Task Sync()
    {
        if (!CanSync) return;
        var epoch = generation; using var cancellation = new CancellationTokenSource(); action = cancellation; Busy = true; Changed();
        try { await Synchronize(epoch, cancellation.Token); }
        catch (Exception error) { if (generation == epoch && !WaitForPolicy(error)) Lock(Friendly(error)); }
        finally { if (ReferenceEquals(action, cancellation)) action = null; if (generation == epoch) { Busy = false; Changed(); } }
    }
    public async Task Connect()
    {
        if (!CanConnect) return;
        var epoch = generation; using var cancellation = new CancellationTokenSource(); action = cancellation; Busy = true; Changed();
        try
        {
            await Synchronize(epoch, cancellation.Token);
            if (generation != epoch || policy is null || SelectedRoute is null) return;
            var (service, bearer) = await Authorize(cancellation.Token);
            if (generation != epoch) return;
            Say("正在启动已授权线路…"); await core.Start(policy, SelectedRoute.Tag, cancellation.Token);
            if (generation != epoch) { core.Stop(); return; }
            if (UseSystemProxy) proxy.Enable(core.Port);
            Watchdog.Start(core, proxy);
            IsConnected = true; activeRoute = SelectedRoute.Tag;
            await service.Ack(policy, "applied", bearer, cancellation.Token);
            if (generation != epoch) return;
            Say(UseSystemProxy ? "已连接。当前用户的系统代理已接管。" : $"已连接本地代理 127.0.0.1:{core.Port}。");
            StartProbesIfDue();
        }
        catch (Exception error) { if (generation == epoch && !WaitForPolicy(error)) Lock(Friendly(error)); }
        finally { if (ReferenceEquals(action, cancellation)) action = null; if (generation == epoch) { Busy = false; Changed(); } }
    }
    public async Task ChooseRoute()
    {
        var desired = SelectedRoute?.Tag;
        if (Busy || !IsAuthenticated || desired is null || !Routes.Any(r => r.Tag == desired) || !IsConnected || desired == activeRoute) return;
        var epoch = generation; using var cancellation = new CancellationTokenSource(); action = cancellation; Busy = true; Say("正在切换线路…");
        try
        {
            try { await Synchronize(epoch, cancellation.Token); }
            catch (Exception error) { if (generation == epoch && !WaitForPolicy(error)) Lock(Friendly(error)); return; }
            if (generation != epoch) return;
            if (!Routes.Any(r => r.Tag == desired)) { Say("该线路授权已更新，请重新选择。"); return; }
            if (!IsConnected) { SelectedRoute = Routes.First(r => r.Tag == desired); Say("配置已更新，请重新连接。"); return; }
            try { await core.Select(desired, cancellation.Token); activeRoute = desired; }
            catch
            {
                if (generation != epoch) return;
                try { activeRoute = await core.Selected(cancellation.Token); }
                catch { Disconnect(); Say("无法确认切换结果，已断开，请重新连接。"); return; }
            }
            if (generation != epoch || !IsConnected) return;
            SelectedRoute = Routes.FirstOrDefault(r => r.Tag == activeRoute);
            Say(activeRoute == desired ? "线路已切换，已有连接会在新线路重新建立。" : "切换未成功，已保持原线路，请重试。");
        }
        finally { if (ReferenceEquals(action, cancellation)) action = null; if (generation == epoch) { Busy = false; Changed(); } }
    }
    void CancelProbes() { var previous = probes; probes = null; previous?.Cancel(); MeasuringLatency = false; }
    void StartProbesIfDue()
    {
        if (!IsAuthenticated || !IsConnected || probes is not null || !ProtocolSecurity.NeedsLatencyRefresh(lastLatency, DateTimeOffset.UtcNow)) return;
        var epoch = generation; var run = core.RunId; var source = new CancellationTokenSource(); probes = source; MeasuringLatency = true; Changed();
        _ = RefreshLatencies(epoch, run, Routes.ToArray(), source);
    }
    async Task RefreshLatencies(Guid epoch, Guid? run, RouteView[] targets, CancellationTokenSource source)
    {
        using var limit = new SemaphoreSlim(4);
        try
        {
            await Task.WhenAll(targets.Select(async route =>
            {
                await limit.WaitAsync(source.Token);
                try
                {
                    var ms = await core.Latency(route.Tag, source.Token);
                    if (generation == epoch && core.RunId == run && IsConnected && ReferenceEquals(probes, source)) route.SetLatency(ms);
                }
                finally { limit.Release(); }
            }));
            if (generation == epoch && core.RunId == run && IsConnected && ReferenceEquals(probes, source)) lastLatency = DateTimeOffset.UtcNow;
        }
        catch (OperationCanceledException) { }
        catch { }
        finally
        {
            if (ReferenceEquals(probes, source)) { probes = null; MeasuringLatency = false; Changed(); }
            source.Dispose();
        }
    }
    public async Task Maintain()
    {
        if (maintenanceRunning || !IsAuthenticated) return;
        maintenanceRunning = true; var epoch = generation;
        try
        {
            await Authorize(CancellationToken.None);
            if (generation != epoch) return;
            if ((IsConnected && !core.Running) || policy?.Expires <= DateTimeOffset.UtcNow) throw new ClientFailure("连接或配置授权已失效，请重新登录。", 403);
            if (!Busy && lastSync is { } at && DateTimeOffset.UtcNow - at > TimeSpan.FromMinutes(5)) await Synchronize(epoch, CancellationToken.None);
            if (!Busy) StartProbesIfDue();
        }
        catch (Exception error) { if (generation == epoch && !WaitForPolicy(error)) Lock("无法确认飞书授权，已停止代理。" + Friendly(error)); }
        finally { maintenanceRunning = false; }
    }
    public void Disconnect()
    {
        CancelProbes(); core.Stop(); IsConnected = false; activeRoute = null;
        try { proxy.Restore(); Say("已断开，系统代理设置已恢复。"); }
        catch { Say("代理已停止，但系统设置尚未恢复。请点击恢复系统代理。"); }
    }
    public void Recover() { try { proxy.Restore(true); Say("已恢复之前的系统代理设置。"); } catch (Exception error) { Say(Friendly(error)); } }
    bool WaitForPolicy(Exception error)
    {
        if (!IsAuthenticated || error is not ClientFailure { PolicyUnavailable: true }) return false;
        Disconnect(); policy = null; Routes.Clear(); SelectedRoute = null; lastLatency = null; lastSync = DateTimeOffset.UtcNow;
        Say("飞书登录成功。" + error.Message + " 请管理员分配并发布线路后同步配置。"); return true;
    }
    void Lock(string reason)
    {
        generation = Guid.NewGuid(); action?.Cancel(); browser.Cancel();
        token = null; sessionExpires = default; api?.Dispose(); api = null; policy = null;
        IsAuthenticated = false; Name = "未登录"; Routes.Clear(); SelectedRoute = null; lastSync = null; lastLatency = null; WaitingBrowser = false; Busy = false;
        Disconnect(); Say(proxy.NeedsRecovery ? reason + " 请恢复系统代理。" : reason);
    }
    public async Task Logout()
    {
        var service = api; var bearer = token; api = null; Lock("已退出飞书登录，配置已清理。");
        if (service is not null)
        {
            try { if (bearer is not null) await service.Request("/api/client/logout", bearer, new { }); } catch { } finally { service.Dispose(); }
        }
    }
    public void Shutdown() { Lock("客户端已退出。"); core.Dispose(); }
}
