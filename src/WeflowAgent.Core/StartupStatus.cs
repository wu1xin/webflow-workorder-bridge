using System;                       // ArgumentOutOfRangeException 等异常类型
using WeflowAgent.Core.Security;     // CredentialLoadStatus（凭据加载状态枚举）

namespace WeflowAgent.Core;

/// <summary>代理整体健康度，对应托盘图标的绿/黄/红。</summary>
//
// `enum`（枚举）= 一组具名的常量集合。当一个变量只可能取"有限几个固定取值"时用它，
// 比用魔法数字/字符串更安全、可读（编译器还能在 switch 里帮你检查是否漏了分支）。
// 这里 AgentHealth 类型的值只能是 Green、Yellow、Red 三者之一。
// 底层其实是整数（默认 Green=0、Yellow=1、Red=2），但平时只管用名字。
public enum AgentHealth
{
    /// <summary>就绪。</summary>
    Green,

    /// <summary>需关注（如未配置凭据）。</summary>
    Yellow,

    /// <summary>异常（如凭据无法解密 / 疑似换机）。</summary>
    Red,
}

/// <summary>启动态的概览状态：健康度 + 给用户的摘要文案。</summary>
//
// 一个简单的"数据 + 一个工厂方法"的类。它把"枚举健康度"和"给用户看的文字"打包在一起。
public sealed class StartupStatus
{
    // 构造函数：接收健康度和摘要，存进两个只读属性。
    public StartupStatus(AgentHealth health, string summary)
    {
        Health = health;
        Summary = summary;
    }

    // 只读属性（只有 get），值在构造时定下、之后不可改。
    public AgentHealth Health { get; }

    public string Summary { get; }

    /// <summary>由凭据加载结果推导启动态（绿/黄/红）。</summary>
    //
    // 静态工厂方法 + switch 表达式：把"凭据加载状态"映射成对应的"健康度 + 文案"。
    // 注意整个方法体就是 `=> status switch { ... };` 一个表达式（表达式体方法）。
    public static StartupStatus FromCredentials(CredentialLoadStatus status) => status switch
    {
        // 每个分支：左边是要匹配的枚举值，`=>` 右边是命中时返回的新 StartupStatus 对象。
        CredentialLoadStatus.Loaded => new StartupStatus(AgentHealth.Green, "凭据就绪。"),
        CredentialLoadStatus.Missing => new StartupStatus(AgentHealth.Yellow, "尚未配置凭据，请在「配置」中录入 WeFlow Token 与下游密钥。"),
        CredentialLoadStatus.Undecryptable => new StartupStatus(AgentHealth.Red, "凭据无法解密（疑似换机/换用户），请重新录入凭据。"),
        // `_ =>` 默认分支：理论上枚举只有上面三种，但万一传进意料之外的值，
        //   就主动 `throw`（抛出）一个异常、让问题立刻暴露，而不是悄悄返回错的结果。
        //   `nameof(status)` 在编译期把变量名转成字符串 "status"，比手写字符串更不易拼错、
        //   且重命名变量时会同步更新。这是给异常标明"是哪个参数出了问题"。
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null),
    };
}
