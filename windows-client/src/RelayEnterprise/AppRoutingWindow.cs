using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace RelayEnterprise;

public sealed class AppRoutingWindow : Window
{
    readonly ClientModel model;
    readonly ComboBox mode = new() { Margin = new(0, 8, 0, 12) };
    readonly TextBox search = new() { Margin = new(0, 0, 10, 0), MinWidth = 290 };
    readonly StackPanel rows = new();
    readonly TextBlock count = new() { Margin = new(0, 10, 0, 8) };
    readonly Dictionary<string, LocalApplication> selected = new(StringComparer.OrdinalIgnoreCase);
    IReadOnlyList<LocalApplication> catalog = [];
    public AppRoutingWindow(ClientModel model)
    {
        this.model = model; Title = "应用分流"; Width = 760; Height = 660; MinHeight = 550; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = new SolidColorBrush(Color.FromRgb(247, 250, 247));
        foreach (var a in model.AppRouting.Applications) selected[a.Path] = a;
        var root = new DockPanel { Margin = new(24) }; Content = root;
        var top = new StackPanel(); DockPanel.SetDock(top, Dock.Top); root.Children.Add(top);
        top.Children.Add(new TextBlock { Text = "应用分流", FontSize = 23, FontWeight = FontWeights.SemiBold });
        top.Children.Add(new TextBlock { Text = "仅对进入本地代理的流量生效。不遵循系统代理的软件不会自动接管；无法识别进程的连接默认直连。", TextWrapping = TextWrapping.Wrap, Margin = new(0, 12, 0, 8) });
        foreach (var (key, label) in new[] { ("all", "全部应用"), ("include", "仅所选应用走代理"), ("exclude", "所选应用不走代理") }) mode.Items.Add(new ComboBoxItem { Content = label, Tag = key });
        mode.SelectedIndex = model.AppRouting.Mode == "include" ? 1 : model.AppRouting.Mode == "exclude" ? 2 : 0;
        top.Children.Add(mode);
        top.Children.Add(new TextBlock { Text = "搜索本机应用或路径" });
        var tools = new DockPanel { Margin = new(0, 7, 0, 12) }; top.Children.Add(tools);
        var browse = new Button { Content = "浏览 .exe…" }; DockPanel.SetDock(browse, Dock.Right); tools.Children.Add(browse);
        var refresh = new Button { Content = "刷新列表" }; DockPanel.SetDock(refresh, Dock.Right); tools.Children.Add(refresh); tools.Children.Add(search);
        var bottom = new StackPanel(); DockPanel.SetDock(bottom, Dock.Bottom); root.Children.Add(bottom); bottom.Children.Add(count);
        bottom.Children.Add(new TextBlock { Text = "按可执行文件路径匹配；独立辅助进程需另外选择。列表来自开始菜单和已安装桌面应用，未列出的程序可浏览添加。设置仅保存在本机，下次连接生效。", TextWrapping = TextWrapping.Wrap, Foreground = Brushes.Gray });
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new(0, 12, 0, 0) }; bottom.Children.Add(buttons);
        var clear = new Button { Content = "清空选择" }; clear.Click += (_, _) => { selected.Clear(); Render(); }; buttons.Children.Add(clear);
        var cancel = new Button { Content = "取消" }; cancel.Click += (_, _) => Close(); buttons.Children.Add(cancel);
        var save = new Button { Content = "保存设置" }; save.Click += (_, _) => { try { model.SaveAppRouting(new(Mode, selected.Values.OrderBy(a => a.Path).ToArray())); DialogResult = true; } catch (Exception e) { MessageBox.Show(this, e.Message, "无法保存"); } }; buttons.Children.Add(save);
        root.Children.Add(new ScrollViewer { Content = rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
        search.TextChanged += (_, _) => Render(); mode.SelectionChanged += (_, _) => Render();
        browse.Click += (_, _) => { var dialog = new OpenFileDialog { Filter = "应用程序 (*.exe)|*.exe", Multiselect = true }; if (dialog.ShowDialog(this) == true) { try { foreach (var path in dialog.FileNames) { var a = ApplicationCatalog.FromPath(path); selected[a.Path] = a; } Render(); } catch (Exception e) { MessageBox.Show(this, e.Message); } } };
        refresh.Click += (_, _) => Scan(); Loaded += (_, _) => Scan();
    }
    string Mode => (mode.SelectedItem as ComboBoxItem)?.Tag as string ?? "all";
    void Scan() { catalog = ApplicationCatalog.Scan(); Render(); }
    void Render()
    {
        rows.Children.Clear();
        foreach (var app in catalog.Concat(selected.Values).DistinctBy(a => a.Path, StringComparer.OrdinalIgnoreCase).Where(a => (a.Name + " " + a.Path).Contains(search.Text, StringComparison.CurrentCultureIgnoreCase)).OrderBy(a => a.Name)) {
            var label = new StackPanel(); label.Children.Add(new TextBlock { Text = app.Name + (File.Exists(app.Path) ? "" : "（已移除）"), FontWeight = FontWeights.SemiBold });
            label.Children.Add(new TextBlock { Text = app.Path, FontSize = 11, Foreground = Brushes.Gray, TextWrapping = TextWrapping.Wrap });
            var check = new CheckBox { Content = label, IsChecked = selected.ContainsKey(app.Path), IsEnabled = Mode != "all", Margin = new(7, 9, 7, 9) };
            check.Checked += (_, _) => { selected[app.Path] = app; Count(); }; check.Unchecked += (_, _) => { selected.Remove(app.Path); Count(); }; rows.Children.Add(check);
        }
        Count();
    }
    void Count() => count.Text = $"已选择 {selected.Count} 个应用";
}
