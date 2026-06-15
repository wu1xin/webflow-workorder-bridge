// ── using 指令 ─────────────────────────────────────────────────────────────
// C# 里用 `using 命名空间;` 把别处定义的类型"引入"到本文件，之后就能直接写类名
// 而不必写全限定名。类似别的语言的 import / #include。
using System.Windows;                       // WPF 的核心类型都在这里：Application、Window、WindowState…
using Hardcodet.Wpf.TaskbarNotification;    // 第三方库（NuGet 包），提供系统托盘图标 TaskbarIcon

// 文件作用域命名空间：`namespace X;`（注意结尾是分号，不是大括号）。
// 表示"本文件里定义的所有类型都归属于 WeflowAgent.App 这个命名空间"。
// 命名空间相当于给类型分组/起前缀，避免不同库里同名类型冲突。
namespace WeflowAgent.App;

/// <summary>应用入口：启动 → 跑启动胶水 → 建托盘 + 主界面（关闭=最小化到托盘）。</summary>
//  ↑ 三个斜杠 `///` 是 "XML 文档注释"。它和普通注释 `//` 的区别：IDE 会把它当成
//    这个类/方法的"官方说明"，鼠标悬停时弹出来提示。<summary> 是其中的标准标签。
//
// `public`  = 访问修饰符，表示这个类对外（其它程序集/文件）都可见。
// `partial` = "分部类"。这个 App 类的代码被拆成两半：一半是你看到的这个 .cs 文件，
//             另一半由配套的 App.xaml 在编译时自动生成（里面有 InitializeComponent 等）。
//             两个文件的内容会被编译器合并成同一个类，所以这里必须写 partial。
// `: Application` = 继承。冒号后面是父类。我们的 App "是一种" WPF 的 Application，
//             从而获得 WPF 应用的生命周期（启动、退出等），并可重写它的行为。
public partial class App : Application
{
    // ── 字段（成员变量）────────────────────────────────────────────────────
    // `private`  = 只在本类内部可见（外部访问不到），是默认且最安全的可见性。
    // `TaskbarIcon?` 里的问号 `?` = "可空引用类型"标记，表示这个变量"允许为 null"。
    //             C# 8 起开启可空检查后，不带 `?` 的引用类型被视为"不应为 null"，
    //             带 `?` 则明确告诉编译器"这里可能是空的，使用前请判空"。
    // `_tray`    = 字段命名约定：私有字段用下划线开头的小驼峰，方便和局部变量区分。
    private TaskbarIcon? _tray;     // 托盘图标对象（启动后才创建，故初始为 null）
    private MainWindow? _window;    // 主窗口对象（同上）

    // ── 重写应用启动事件 ──────────────────────────────────────────────────
    // `protected` = 本类及其子类可见（比 private 宽、比 public 窄）。
    // `override`  = "重写"。父类 Application 里已有一个 OnStartup 方法，WPF 在应用启动时
    //               会自动调用它；我们用 override 替换成自己的版本，插入自定义启动逻辑。
    // 参数 `StartupEventArgs e` = WPF 传进来的启动事件参数对象（含命令行参数等）。
    protected override void OnStartup(StartupEventArgs e)
    {
        // 先调用父类原本的实现（`base` 指代父类），保证 WPF 内部该做的初始化照常进行。
        // 重写时通常都要记得调一次 base.方法()，否则可能漏掉框架的默认行为。
        base.OnStartup(e);

        // 关闭/隐藏窗口不退出进程，仅托盘菜单「退出」才结束（常驻托盘）。
        // ShutdownMode 是 Application 的一个属性，决定"什么时候算应用该退出"。
        // OnExplicitShutdown = 只有显式调用 Shutdown() 才退出（默认是关掉最后一个窗口就退）。
        // 右边 `ShutdownMode.OnExplicitShutdown` 是枚举值（一组具名常量里的一个，见后面 enum）。
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        // 调用启动胶水，把"建目录、迁移、读凭据、算健康度"一条龙跑完，拿到结果对象。
        // `BootstrapResult` 是返回值的类型；这里显式写出类型（也可写 `var` 让编译器推断）。
        // `AgentBootstrapper.Run()` = 调用 AgentBootstrapper 类的静态方法 Run（静态=不用先 new 对象）。
        BootstrapResult result = AgentBootstrapper.Run();

        // `new MainWindow()` = 创建（实例化）一个主窗口对象。`new` 关键字调用构造函数。
        _window = new MainWindow();
        _window.ApplyStatus(result);    // 调用窗口上的方法，把启动结果填进界面。`.` 是成员访问运算符。
        // 装载配置编辑器：把已读到的配置 / 凭据 / 保存服务交给界面，使「配置」区可录入、可保存。
        _window.InitializeConfigEditor(result.Config, result.Credentials, result.SaveService);

        // 创建托盘图标。注意这里的写法：
        // `result.Status.Health` = 链式访问：result 的 Status 属性，再取它的 Health 属性。
        // `onOpen: ShowMainWindow` = "命名实参"：显式指明这个参数叫 onOpen。
        //   而 ShowMainWindow（没有括号）是把"方法本身"当作值传进去（方法引用/委托），
        //   托盘以后被点击时再回头调用它——这就是"回调"。带括号 ShowMainWindow() 才是立即调用。
        _tray = TrayIcon.Create(result.Status.Health, onOpen: ShowMainWindow, onExit: ExitApp);

        // 骨架阶段：启动即显示主界面（正式版可配置「启动即最小化」FR-BOOT-04）。
        ShowMainWindow();
    }

    // ── 私有辅助方法：显示主窗口 ───────────────────────────────────────────
    private void ShowMainWindow()
    {
        // `is null` = 模式匹配判空，等价于 `_window == null`，但更推荐这种写法。
        // 若窗口还没创建就直接 `return;` 提前结束方法，避免对 null 调用方法导致崩溃。
        if (_window is null)
            return;

        _window.Show();                          // 显示窗口
        _window.WindowState = WindowState.Normal; // 还原窗口（不是最小化/最大化）
        _window.Activate();                       // 把窗口激活到前台、抢占焦点
    }

    // ── 私有辅助方法：真正退出应用 ─────────────────────────────────────────
    private void ExitApp()
    {
        // `?.` = "空条件运算符"：若 _tray 为 null 就整体跳过、不调用 Dispose；
        //        否则才调用 Dispose() 释放托盘图标占用的系统资源（图标会从任务栏消失）。
        //        没有它的话，对 null 调用 .Dispose() 会抛 NullReferenceException。
        _tray?.Dispose();
        Shutdown();     // Application 的方法：显式触发应用退出（配合上面的 OnExplicitShutdown）。
    }

    // ── 重写应用退出事件 ──────────────────────────────────────────────────
    // 应用真正退出前 WPF 会调用 OnExit，这里再兜底释放一次托盘资源，确保不残留。
    protected override void OnExit(ExitEventArgs e)
    {
        _tray?.Dispose();
        base.OnExit(e);
    }
}
