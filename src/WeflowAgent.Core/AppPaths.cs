using System;       // Environment（读取系统目录等）
using System.IO;     // Path、Directory（路径拼接、目录创建）——IO = 输入输出

namespace WeflowAgent.Core;

/// <summary>
/// 解析本地状态目录与各状态文件的路径。
/// 本地状态统一存于 <c>%LocalAppData%\&lt;App&gt;</c>，与程序二进制分离（见 SRS FR-SYNC-07）。
/// </summary>
//  注：文档注释里 <c>…</c> 表示"等宽代码字体"；因为 < > 在 XML 里是特殊字符，
//      要表示字面的尖括号得写成转义实体 &lt; （<）和 &gt; （>）。
//
// `sealed`（密封）：禁止其它类继承本类。一个职责单一的工具类通常封死，意图更清晰。
public sealed class AppPaths
{
    // 构造函数：new AppPaths("某根目录") 时调用，把传入的根目录存进只读属性。
    public AppPaths(string rootDirectory)
    {
        RootDirectory = rootDirectory;
    }

    /// <summary>
    /// 当前用户的状态目录：<c>%LocalAppData%\&lt;appName&gt;</c>。
    /// 免提权可写、与二进制分离（绿色版部署）。
    /// </summary>
    //
    // 静态"工厂方法"：不直接 new，而是通过 AppPaths.ForCurrentUser() 拿到对象，可读性更好。
    // 参数 `string appName = "WeflowAgent"` 里的 `= "..."` 是"默认值"：调用时不传就用它，
    //   想覆盖也可以传别的（如测试时传临时目录名）。
    public static AppPaths ForCurrentUser(string appName = "WeflowAgent")
    {
        // Environment.GetFolderPath(...) 查询 Windows 的某个特殊目录的真实路径。
        // SpecialFolder.LocalApplicationData 对应 %LocalAppData%（如 C:\Users\你\AppData\Local），
        //   这是"当前用户本机的应用数据目录"，普通权限即可写，适合放程序状态。
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        // Path.Combine 智能拼接路径（自动处理斜杠），比手动字符串拼接更安全、跨平台。
        return new AppPaths(Path.Combine(localAppData, appName));
    }

    // ── 下面是一组"属性"。属性是带 get/set 访问器的成员，外部用起来像字段（obj.RootDirectory）。──

    /// <summary>状态根目录。</summary>
    // `{ get; }` = "只读自动属性"：只有 get、没有 set，只能在构造函数里赋值一次，之后不可改。
    public string RootDirectory { get; }

    /// <summary>普通配置（可移植）。</summary>
    // 这种 `=> 表达式;` 写法叫"表达式体属性"（只读、计算型）：每次读取它时即时算出值返回，
    // 而不是存一个字段。这里每次都把根目录和 "config.json" 拼出完整路径。
    public string ConfigFile => Path.Combine(RootDirectory, "config.json");

    /// <summary>DPAPI 加密的敏感凭据（不可移植，换机需重录）。</summary>
    public string SecretsFile => Path.Combine(RootDirectory, "secrets.dat");

    /// <summary>断点 / 去重表 / 队列 / 死信（LiteDB）。</summary>
    public string StateDbFile => Path.Combine(RootDirectory, "state.db");

    /// <summary>日志目录。</summary>
    public string LogsDirectory => Path.Combine(RootDirectory, "logs");

    /// <summary>确保状态根目录与日志目录存在（不存在则创建）。</summary>
    //
    // 普通方法（有大括号方法体）。Directory.CreateDirectory 若目录已存在则什么都不做、
    // 不存在才创建（且会一并创建中间缺失的父目录），所以重复调用是安全的。
    public void EnsureCreated()
    {
        Directory.CreateDirectory(RootDirectory);
        Directory.CreateDirectory(LogsDirectory);
    }
}
