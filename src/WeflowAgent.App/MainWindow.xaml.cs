using System.ComponentModel;       // CancelEventArgs（窗口关闭事件的参数类型）
using System.Globalization;        // CultureInfo（控制数字/日期按哪国习惯格式化）
using System.Windows.Media;        // Color、SolidColorBrush（颜色与画刷）
using WeflowAgent.Core;            // AgentHealth、BootstrapResult 里用到的 Core 类型
using Wpf.Ui.Controls;             // FluentWindow（WPF UI 库提供的 Win11 风格窗口基类）

namespace WeflowAgent.App;

/// <summary>主界面（Fluent）：状态概览 / 配置 / 日志 / 测试 四区。</summary>
//
// 同样是 `partial`（分部类）：另一半在 MainWindow.xaml 里、编译时自动生成。
// `: FluentWindow` = 继承自 WPF UI 的 FluentWindow（它本身又继承自 WPF 的 Window），
//   于是这个窗口自带 Fluent/Mica 等 Win11 外观，同时拥有普通窗口的全部能力。
public partial class MainWindow : FluentWindow
{
    // 构造函数：和类同名、无返回类型，`new MainWindow()` 时被调用，用来初始化对象。
    public MainWindow()
    {
        // InitializeComponent 由 XAML 编译自动生成（就在那"另一半"分部类里）。
        // 它负责把 MainWindow.xaml 里描述的控件树真正创建出来并接好。
        // WPF 窗口的构造函数里几乎总要调它，否则界面是空的。
        InitializeComponent();
    }

    /// <summary>把启动态结果填入状态概览区。</summary>
    // public 方法，供外部（App.xaml.cs 里）调用，传入启动结果来刷新界面。
    public void ApplyStatus(BootstrapResult result)
    {
        // ── 元组 + 解构 + switch 表达式，三个特性一次用上 ──────────────────
        // 右边 `result.Status.Health switch { ... }` 是 "switch 表达式"：
        //   它根据 Health 的值，从下面几个分支里"选一个并返回值"（注意是返回值，不是执行语句）。
        //   每个分支写法是 `匹配值 => 结果,`。最后的 `_ =>` 是"默认分支"（下划线表示"其它任何值"）。
        //   每个分支这里返回的是一个"元组"——用圆括号打包的多个值 (颜色, 文案)。
        // 左边 `(Color color, string label) =` 是"解构"：把右边返回的元组当场拆成
        //   两个独立变量 color 和 label。一行就完成了"按状态算出颜色和文字"。
        //
        // Color.FromRgb(r, g, b) 用红绿蓝三分量造颜色；0x 前缀表示十六进制数（0x3F = 63）。
        (Color color, string label) = result.Status.Health switch
        {
            AgentHealth.Green => (Color.FromRgb(0x3F, 0xB9, 0x50), "● 就绪"),
            AgentHealth.Yellow => (Color.FromRgb(0xE8, 0xB1, 0x1E), "● 需配置"),
            _ => (Color.FromRgb(0xE3, 0x4A, 0x3A), "● 异常"),
        };

        // 下面这些 HealthPill / HealthText / SummaryText … 看似凭空出现，其实它们是
        // MainWindow.xaml 里用 x:Name="..." 命名过的控件——XAML 编译后会自动生成同名字段，
        // 所以在 C# 这边能直接按名字访问、修改这些界面控件。
        HealthPill.Background = new SolidColorBrush(color);   // 背景色画刷（纯色）。Border 的背景。
        HealthText.Text = label;                              // 设置那段状态文字
        SummaryText.Text = result.Status.Summary;             // 摘要说明文字
        StateDirText.Text = result.Paths.RootDirectory;       // 显示状态目录路径

        // .ToString(...) 把数字转成字符串。传 CultureInfo.InvariantCulture 表示
        // "用与文化无关的固定格式"，避免不同地区把数字格式化成不同样子（如千分位/小数点差异）。
        SchemaText.Text = result.SchemaVersion.ToString(CultureInfo.InvariantCulture);
    }

    // ── 重写窗口关闭事件 ──────────────────────────────────────────────────
    // 用户点窗口右上角 ✕ 时，WPF 会先调用 OnClosing。参数 e 让我们能"拦截/取消"这次关闭。
    protected override void OnClosing(CancelEventArgs e)
    {
        // 关闭窗口默认最小化到托盘（FR-UI-04），仅托盘菜单「退出」才真正结束进程。
        e.Cancel = true;    // 把"取消关闭"设为 true → 这次关闭被拦下，窗口不会真的销毁。
        Hide();             // 改为隐藏窗口（人看不见，但对象还活着，常驻托盘）。
        base.OnClosing(e);  // 仍调一次父类实现，保持框架默认流程完整。
    }
}
