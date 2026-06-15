using System;                                   // Action（一种"无参无返回的方法"委托类型）
using System.Windows;                            // MessageBox 等
using System.Windows.Controls;                   // ContextMenu、MenuItem、Separator（菜单相关控件）
using System.Windows.Media;                      // Color、Brush、Geometry、ImageSource…（绘图）
using System.Windows.Media.Imaging;              // BitmapImage（从 pack URI 加载 .ico 资源）
using Hardcodet.Wpf.TaskbarNotification;         // TaskbarIcon（第三方托盘图标控件）
using WeflowAgent.Core;                          // AgentHealth 枚举

namespace WeflowAgent.App;

/// <summary>系统托盘图标工厂：绿/黄/红状态点 + 右键菜单（对应 SRS FR-UI-02/03）。</summary>
//
// `internal` = 访问修饰符，表示"只在本程序集（本项目编译出的 dll/exe）内可见"，
//   对外部项目不可见。比 public 窄、比 private 宽，适合"项目内部用的工具类"。
// 又是 `static class`：纯工具方法集合，不需要 new。
internal static class TrayIcon
{
    // 这是个"工厂方法"：负责造出并配置好一个 TaskbarIcon 再返回。
    // 参数里的 `Action onOpen` / `Action onExit`：
    //   Action 是 .NET 内置的"委托类型"，代表"一个可被调用、无参数、无返回值的方法"。
    //   把方法当参数传进来，就能实现"现在先收下、以后某事件发生时再回头调用"——即回调。
    //   （回顾 App.xaml.cs：传进来的正是 ShowMainWindow 和 ExitApp 两个方法。）
    public static TaskbarIcon Create(AgentHealth health, Action onOpen, Action onExit)
    {
        // "对象初始化器"语法：new 类型 { 属性 = 值, 属性 = 值 }。
        // 在创建对象的同时给若干属性赋值，免去一行行单独赋值。
        var tray = new TaskbarIcon
        {
            ToolTipText = "weflow 工单转发代理",   // 鼠标悬停在托盘图标上时的提示文字
            IconSource = DotIcon(health),          // 图标图像，由下面的 DotIcon 按健康度画出彩色圆点
        };

        // 构建右键上下文菜单。
        var menu = new ContextMenu();
        // menu.Items 是菜单项集合；.Add(...) 往里添加一项。
        // MenuItem(...) 是本类下面定义的私有辅助方法，造一个"文字 + 点击回调"的菜单项。
        menu.Items.Add(MenuItem("打开主界面", onOpen));
        menu.Items.Add(new Separator());           // Separator = 菜单里的一条分隔横线
        // 这里传的回调是 lambda 表达式：`() => NotImplemented("启停转发")`。
        //   `() =>` 表示"一个无参方法"，箭头右边是它的方法体。即"被点时就弹出未实现提示"。
        //   lambda 是"就地写一个小匿名方法"的简便语法，常用来当回调。
        menu.Items.Add(MenuItem("启动 / 停止转发", () => NotImplemented("启停转发")));
        menu.Items.Add(MenuItem("手动重连", () => NotImplemented("手动重连")));
        menu.Items.Add(MenuItem("主动同步（手动补偿）", () => NotImplemented("主动同步")));
        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItem("退出", onExit));   // 退出项绑定外面传进来的 onExit 回调
        tray.ContextMenu = menu;                    // 把菜单挂到托盘图标上

        // 订阅"双击托盘"事件。`+=` 是"添加事件处理器"：当事件触发时，会调用右边的方法。
        //   `(_, _) =>` 里两个下划线是"丢弃符"：事件回调本应收到 (发送者, 事件参数) 两个参数，
        //   但这里都用不到，于是用 _ 占位表示"我不关心这两个参数"。方法体就是调用 onOpen()。
        tray.TrayMouseDoubleClick += (_, _) => onOpen();
        return tray;    // 把配置好的托盘图标返回给调用者
    }

    /// <summary>更新托盘图标的状态颜色。</summary>
    //
    // "表达式体成员"：方法体只有一个表达式时，可用 `=> 表达式;` 代替 `{ return ...; }`/`{ ...; }`。
    // 这一行等价于：public static void SetHealth(...) { tray.IconSource = DotIcon(health); }
    public static void SetHealth(TaskbarIcon tray, AgentHealth health) => tray.IconSource = DotIcon(health);

    // 私有辅助：根据"文字 + 点击回调"造一个菜单项。
    private static MenuItem MenuItem(string header, Action onClick)
    {
        var item = new MenuItem { Header = header };   // Header 是菜单项显示的文字
        item.Click += (_, _) => onClick();             // 订阅 Click 事件：被点时调用传入的回调
        return item;
    }

    // 私有辅助：弹一个"功能未实现"的信息对话框。也是表达式体写法。
    // `$"...{feature}..."` 是"字符串插值"：以 $ 开头的字符串里，花括号 {变量} 会被替换成变量的值。
    private static void NotImplemented(string feature) =>
        MessageBox.Show($"「{feature}」为骨架占位，待后续模块实现。", "weflow 代理", MessageBoxButton.OK, MessageBoxImage.Information);

    /// <summary>
    /// 按健康度取托盘图标：优先加载品牌化的状态 .ico（绿/黄/红 的"转发»"雪佛龙），
    /// 万一资源缺失/加载异常，降级为纯 WPF 代码绘制的同色雪佛龙（保证托盘永远有图标、不崩）。
    /// </summary>
    private static ImageSource DotIcon(AgentHealth health)
    {
        // 健康度 → 资源名后缀（与 Assets\tray-*.ico 对应）。
        string key = health switch
        {
            AgentHealth.Green => "green",     // 绿：链路正常
            AgentHealth.Yellow => "yellow",   // 黄：需配置 / 降级
            _ => "red",                       // 红：异常 / 疑似换机
        };

        try
        {
            // pack URI：加载编进本程序集的资源（见 .csproj 的 <Resource Include="Assets\*.ico" />）。
            // 三斜杠后即程序集内路径。DecodePixelHeight=16 让多帧 .ico 选出 16px 那一帧（托盘实际显示尺寸）。
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.UriSource = new Uri($"pack://application:,,,/Assets/tray-{key}.ico", UriKind.Absolute);
            bmp.DecodePixelHeight = 16;
            bmp.CacheOption = BitmapCacheOption.OnLoad;   // 立即解码并释放流，避免文件/资源句柄占用
            bmp.EndInit();
            bmp.Freeze();                                  // 冻结：跨线程安全 + 渲染更快
            return bmp;
        }
        catch
        {
            // 兜底：资源没打进去或解码失败时，用代码画一个同色"转发»"雪佛龙。
            return FallbackChevron(health);
        }
    }

    /// <summary>降级方案：纯 WPF 矢量绘制状态色雪佛龙（与方向 B 一致），免任何外部资源。</summary>
    private static ImageSource FallbackChevron(AgentHealth health)
    {
        Color color = health switch
        {
            AgentHealth.Green => Color.FromRgb(0x3F, 0xB9, 0x50),
            AgentHealth.Yellow => Color.FromRgb(0xE8, 0xB1, 0x1E),
            _ => Color.FromRgb(0xE3, 0x4A, 0x3A),
        };

        // 在 ~20×20 坐标系里画一个开口折线 ">"：上 → 尖 → 下。
        var fig = new PathFigure { StartPoint = new Point(7, 4), IsClosed = false, IsFilled = false };
        fig.Segments.Add(new LineSegment(new Point(14, 10), true));
        fig.Segments.Add(new LineSegment(new Point(7, 16), true));
        var geo = new PathGeometry();
        geo.Figures.Add(fig);

        // 用一支圆头、圆角拐点的粗笔描这条折线（fill=null，只描边）。
        var pen = new Pen(new SolidColorBrush(color), 3.4)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
            LineJoin = PenLineJoin.Round,
        };
        var drawing = new GeometryDrawing(null, pen, geo);
        var image = new DrawingImage(drawing);
        image.Freeze();
        return image;
    }
}
