using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace RelayEnterprise;

public partial class MainWindow : Window
{
    public ClientModel Model { get; }
    readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(30) };
    public MainWindow()
    {
        Model = new(action => Dispatcher.BeginInvoke(action));
        InitializeComponent(); DataContext = Model;
        timer.Tick += async (_, _) => await Model.Maintain(); timer.Start();
        Closed += (_, _) => { timer.Stop(); Model.Shutdown(); Application.Current.Shutdown(); };
    }
    async void Login(object sender, RoutedEventArgs e) { if (Model.WaitingBrowser) Model.Reopen(); else await Model.Login(); }
    void CancelLogin(object sender, RoutedEventArgs e) => Model.CancelLogin();
    async void Logout(object sender, RoutedEventArgs e) => await Model.Logout();
    async void Sync(object sender, RoutedEventArgs e) => await Model.Sync();
    async void Connect(object sender, RoutedEventArgs e) => await Model.Connect();
    void Disconnect(object sender, RoutedEventArgs e) => Model.Disconnect();
    void Recover(object sender, RoutedEventArgs e) => Model.Recover();
    void AppRouting(object sender, RoutedEventArgs e) { if (Model.CanEditProxy) new AppRoutingWindow(Model) { Owner = this }.ShowDialog(); }
    async void RouteChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await Model.ChooseRoute(); }
}
