namespace RelayEnterprise;

public sealed class BrowserLogin(Func<Uri, bool> open)
{
    sealed record Pending(Uri Url, string Transaction, TaskCompletionSource<Uri> Completion);
    readonly object gate = new();
    Pending? pending;
    public async Task<Uri> Begin(Uri uri, string transaction, CancellationToken cancellation, TimeSpan? timeout = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var current = new Pending(uri, transaction, new(TaskCreationOptions.RunContinuationsAsynchronously));
        lock (gate) { if (pending is not null) throw new ClientFailure("已有登录正在进行。"); pending = current; }
        try
        {
            if (!open(uri)) throw new ClientFailure("无法打开默认浏览器，请检查系统设置后重试。");
            return await current.Completion.Task.WaitAsync(timeout ?? TimeSpan.FromMinutes(5), cancellation);
        }
        catch (TimeoutException) { throw new ClientFailure("飞书登录已超时，请重新发起登录。"); }
        finally { lock (gate) { if (pending == current) pending = null; } }
    }
    public bool Reopen()
    {
        Pending? current; lock (gate) current = pending;
        return current is not null && open(current.Url);
    }
    public bool Accept(Uri uri)
    {
        lock (gate)
        {
            if (pending is null || ProtocolSecurity.Callback(uri, pending.Transaction) is null) return false;
            var current = pending; pending = null;
            return current.Completion.TrySetResult(uri);
        }
    }
    public void Cancel()
    {
        Pending? current; lock (gate) { current = pending; pending = null; }
        current?.Completion.TrySetException(new ClientFailure("已取消飞书登录。"));
    }
}
