using System;   // [Flags]

namespace WeflowAgent.Core.Configuration;

// ── 配置里用到的枚举集合 ─────────────────────────────────────────────────────
// 枚举把"只可能取有限几个固定值"的配置项约束成具名常量，比裸字符串/数字更安全、更易读，
// 界面上也能直接渲染成下拉框。下面每个枚举对应 SRS §6 某一配置项的"取值范围"。

/// <summary>媒体判定方式（SRS §6 媒体 / FR-RECV-05）。</summary>
public enum MediaDetectMode
{
    /// <summary>按 content 占位符（如 [图片]）判定，默认。</summary>
    Placeholder,

    /// <summary>每条消息都探测一次（更准但更慢）。</summary>
    PerMessageProbe,
}

/// <summary>媒体本地取回方式（FR-MEDIA-02）。</summary>
public enum MediaFetchMode
{
    /// <summary>直接读 mediaLocalPath 本地文件（同机同用户有权限），默认。</summary>
    LocalFile,

    /// <summary>备选：经 localhost mediaUrl 取回。</summary>
    LocalhostUrl,
}

/// <summary>媒体超限处理策略（FR-MEDIA-08）。</summary>
public enum OversizePolicy
{
    /// <summary>整条入死信，默认。</summary>
    DeadLetter,

    /// <summary>仅发正文 + 占位（丢弃超限媒体）。</summary>
    BodyOnlyWithPlaceholder,
}

/// <summary>初始同步策略（首装/无断点时，FR-SYNC-02）。</summary>
public enum InitialSyncStrategy
{
    /// <summary>从现在开始：断点=首启时间戳，只转发此后新消息（默认，严禁全量回灌）。</summary>
    FromNow,

    /// <summary>从指定时间点开始（配合 SpecifiedStartTime）。</summary>
    SpecifiedTime,

    /// <summary>回溯最近 N 小时（配合 InitialLookbackHours）。</summary>
    LookbackHours,

    /// <summary>（高级、需二次确认、不推荐）全量回灌历史。</summary>
    FullBackfill,
}

/// <summary>卸载时本地状态处理（FR-SYNC-07）。</summary>
public enum UninstallStatePolicy
{
    /// <summary>保留断点与队列，便于重装续投，默认。</summary>
    Keep,

    /// <summary>彻底清除全部本地状态。</summary>
    Purge,
}

/// <summary>日志级别（FR-LOG-01）。</summary>
public enum LogLevel
{
    Debug,
    Info,
    Warn,
    Error,
}

/// <summary>
/// 拉取补偿触发时机（FR-REL-03）。标 [Flags] 表示可"位或"组合多项，
/// 如 Reconnect | Startup | Scheduled 表示三种时机都触发。
/// </summary>
[Flags]
public enum CatchupTriggers
{
    None = 0,
    /// <summary>SSE 重连后触发。</summary>
    Reconnect = 1,
    /// <summary>程序启动后触发。</summary>
    Startup = 2,
    /// <summary>定时巡检触发。</summary>
    Scheduled = 4,
}
