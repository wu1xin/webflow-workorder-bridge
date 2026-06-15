using System;                           // 基础类型与工具，如 Array
using WeflowAgent.Core;                  // 引用 Core 库里的 AppPaths、StartupStatus、AgentHealth 等
using WeflowAgent.Core.Persistence;      // SchemaMigrator、ISchemaMigration（模式迁移）
using WeflowAgent.Core.Security;         // CredentialStore、DpapiCredentialProtector（凭据）

namespace WeflowAgent.App;

/// <summary>启动态结果：状态目录、模式版本、概览状态（绿/黄/红）。</summary>
//
// 这是一个 "record（记录类型）"。record 是 C# 9 引入的语法糖，专门用来表示
// "一坨只读数据"。下面这一行的括号写法叫"主构造函数"，它会自动帮你生成：
//   · 三个只读属性 Paths、SchemaVersion、Status；
//   · 一个接收这三者的构造函数；
//   · 基于"值"的相等比较、ToString() 等。
// 等价于普通类里写一大堆样板代码，但 record 一行搞定，非常适合做数据载体（DTO）。
// `sealed` = 密封，禁止别的类再继承它（数据载体一般不需要被继承，封死更清晰安全）。
public sealed record BootstrapResult(AppPaths Paths, int SchemaVersion, StartupStatus Status);

/// <summary>
/// 启动胶水：串起 %LocalAppData% 状态目录、schemaVersion 迁移、DPAPI 凭据加载，
/// 推导出托盘的绿/黄/红状态。各底层单元均已在 Core 单元测试中覆盖。
/// </summary>
//
// `static class` = 静态类：不能被 new 成对象，里面只能放静态成员，直接用"类名.成员"调用。
// 适合放这种"无内部状态、纯粹一组工具函数"的代码（这里就一个 Run 方法）。
public static class AgentBootstrapper
{
    /// <summary>当前本地存储模式版本（升级时由 <see cref="SchemaMigrator"/> 平滑迁移）。</summary>
    //
    // `const` = 编译期常量，值在编译时就定死、永不可改（区别于运行时才赋值的字段）。
    // 命名用大驼峰 CurrentSchemaVersion。`<see cref="..."/>` 是文档注释里的"交叉引用"，
    // 在 IDE 里会渲染成可点击的链接，跳到被引用的类型。
    public const int CurrentSchemaVersion = 1;

    // 静态方法：无需先创建对象即可调用（前面在 App.xaml.cs 里就是直接 AgentBootstrapper.Run()）。
    // 返回类型是上面那个 record：BootstrapResult。
    public static BootstrapResult Run()
    {
        // 1) 状态目录：%LocalAppData%\WeflowAgent，与二进制分离、免提权。
        // `var` = 让编译器"自动推断"变量类型（右边是 AppPaths，paths 就被推断为 AppPaths）。
        //         它只是少写类型名，不是动态类型，编译后类型依然是写死的、强类型的。
        var paths = AppPaths.ForCurrentUser();
        paths.EnsureCreated();      // 调用实例方法：确保目录真实存在（不存在就创建）。

        // 2) 模式迁移占位：v1 尚无历史迁移；升级时在此注册 ISchemaMigration。
        // `Array.Empty<ISchemaMigration>()` = 取一个"空的 ISchemaMigration 数组"。
        //   尖括号 <ISchemaMigration> 是"泛型"实参：指明这个数组里装的元素类型。
        //   用 Array.Empty<T>() 而不是 new T[0]，是因为它返回共享的空数组、不额外分配内存。
        var migrator = new SchemaMigrator(CurrentSchemaVersion, Array.Empty<ISchemaMigration>());
        int schemaVersion = migrator.Migrate(CurrentSchemaVersion);     // 执行迁移，返回迁移后的版本号

        // 3) 凭据加载：Loaded=就绪 / Missing=需配置 / Undecryptable=疑似换机需重录。
        // 这里把一个新建的 DpapiCredentialProtector 作为参数传给 CredentialStore，
        // 即"CredentialStore 依赖一个加解密器"——这种把依赖从外面塞进来的写法叫"依赖注入"，
        // 好处是测试时可换成假的加解密器。
        var store = new CredentialStore(paths.SecretsFile, new DpapiCredentialProtector());
        CredentialLoadResult load = store.Load();                       // 读取并尝试解密凭据
        StartupStatus status = StartupStatus.FromCredentials(load.Status); // 由凭据状态推导绿/黄/红

        // 把三个结果打包进 record 返回。new BootstrapResult(...) 调用的就是 record 自动生成的构造函数。
        return new BootstrapResult(paths, schemaVersion, status);
    }
}
