using Microsoft.Win32;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Windows;

namespace RelayEnterprise;

public partial class App : Application
{
    Mutex? mutex;
    bool ownsMutex;
    readonly CancellationTokenSource lifetime = new();
    MainWindow? window;
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (e.Args.FirstOrDefault() == "--watchdog") { await Watchdog.Run(e.Args); Shutdown(); return; }
        var identity = WindowsIdentity.GetCurrent().User!.Value;
        var pipeName = "RitFit.RelayEnterprise." + identity;
        mutex = new(true, @"Local\" + pipeName, out ownsMutex);
        if (!ownsMutex)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
                await pipe.ConnectAsync(4000);
                var value = e.Args.FirstOrDefault(a => a.StartsWith("relay-enterprise:", StringComparison.OrdinalIgnoreCase)) ?? "";
                if (value.Length <= 4096) { var bytes = Encoding.UTF8.GetBytes(value + "\n"); await pipe.WriteAsync(bytes); }
            }
            catch { MessageBox.Show("客户端正在启动，请稍后重新打开登录。", "Relay 企业连接"); }
            Shutdown(); return;
        }
        try
        {
            window = new MainWindow(); MainWindow = window; window.Show();
            try { RegisterProtocol(); } catch { window.Model.ConfigurationError(); }
            _ = Listen(pipeName, lifetime.Token);
            Receive(e.Args.FirstOrDefault(a => a.StartsWith("relay-enterprise:", StringComparison.OrdinalIgnoreCase)));
        }
        catch { MessageBox.Show("客户端启动失败，请检查当前用户目录权限或重新安装。", "Relay 企业连接"); Shutdown(1); }
    }
    static void RegisterProtocol()
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException();
        if (!executable.EndsWith("RelayEnterprise.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\relay-enterprise");
        key.SetValue("", "URL:Relay Enterprise Login"); key.SetValue("URL Protocol", "");
        using var command = key.CreateSubKey(@"shell\open\command"); command.SetValue("", $"\"{executable}\" \"%1\"");
    }
    async Task Listen(string name, CancellationToken cancellation)
    {
        while (!cancellation.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(cancellation);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation); timeout.CancelAfter(TimeSpan.FromSeconds(5));
                var bytes = new List<byte>(); var buffer = new byte[1];
                while (bytes.Count <= 4096 && await pipe.ReadAsync(buffer, timeout.Token) > 0) { if (buffer[0] == 10) break; bytes.Add(buffer[0]); }
                if (bytes.Count <= 4096) { var message = Encoding.UTF8.GetString(bytes.ToArray()); await Dispatcher.InvokeAsync(() => Receive(message)); }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
            catch { }
        }
    }
    void Receive(string? value)
    {
        if (window is null) return;
        if (!string.IsNullOrEmpty(value) && Uri.TryCreate(value, UriKind.Absolute, out var uri)) window.Model.AcceptCallback(uri);
        if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
        window.Show(); window.Activate();
    }
    protected override void OnExit(ExitEventArgs e)
    {
        lifetime.Cancel(); window?.Model.Shutdown();
        if (ownsMutex) mutex?.ReleaseMutex(); mutex?.Dispose(); lifetime.Dispose(); base.OnExit(e);
    }
}
