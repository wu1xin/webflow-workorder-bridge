using System;                              // DateTime?
using System.Collections.Generic;          // List<string>
using System.Text.Json.Serialization;      // [JsonIgnore]（固定项不入 config.json）

namespace WeflowAgent.Core.Configuration;

// ── 非敏感配置模型（对应 SRS §6 配置项清单）────────────────────────────────────
// 设计要点：
//  · 分组嵌套——根 AgentConfig 内含 12 个 *Options 子对象，与 §6 分组、与配置界面左侧导航一一对应。
//  · `new AgentConfig()` 即一份合理默认配置：所有字段用"属性初始化器"给出 §6 的默认值，
//    于是 ConfigStore 首次无文件时直接 new 一个即可；JSON 反序列化缺字段也回落到这些默认值。
//  · 敏感三项（WeFlow Token / 下游 site key / AES 密钥）不在这里——它们走 DPAPI 的 CredentialSet。
//  · 契约固定的只读项（成功判定、转存方式、去重键、交付形态）用 get-only 属性，
//    并标 [JsonIgnore] 不写入 config.json（避免冗余、也防被手改）。

/// <summary>WeFlow 上游 SSE 接入配置（§6 WeFlow 组）。</summary>
public sealed class WeFlowOptions
{
    /// <summary>WeFlow 本机基础地址 host:port。</summary>
    public string HostPort { get; set; } = "127.0.0.1:5031";

    /// <summary>SSE 推送路径。</summary>
    public string SsePath { get; set; } = "/api/v1/push/messages";

    /// <summary>读超时（秒）：窗口内无数据即重连（FR-CONN-05）。</summary>
    public int ReadTimeoutSeconds { get; set; } = 60;

    /// <summary>重连退避起始（秒）。</summary>
    public int ReconnectBackoffStartSeconds { get; set; } = 1;

    /// <summary>重连退避上限（秒）。</summary>
    public int ReconnectBackoffMaxSeconds { get; set; } = 30;

    /// <summary>最大重连次数；0 = 无限（FR-CONN-04）。</summary>
    public int MaxReconnectAttempts { get; set; } = 0;

    /// <summary>/health 探活间隔（秒）。</summary>
    public int HealthIntervalSeconds { get; set; } = 30;
}

/// <summary>下游 work-order-system 调用配置（§6 下游组）。</summary>
public sealed class DownstreamOptions
{
    /// <summary>下游 Base URL（待提供，必填且须 https，见 FR-SEC-02）。</summary>
    public string? BaseUrl { get; set; }

    /// <summary>每次请求实时生成 token（适配 time 时效校验，FR-AUTH-04）。</summary>
    public bool RealtimeTokenGeneration { get; set; } = true;

    /// <summary>请求 / ACK 超时（秒）。</summary>
    public int RequestTimeoutSeconds { get; set; } = 15;

    /// <summary>重试次数（FR-FWD-08）。</summary>
    public int RetryCount { get; set; } = 3;

    /// <summary>重试退避（秒）。</summary>
    public int RetryBackoffSeconds { get; set; } = 2;

    /// <summary>成功判定：契约固定为 HTTP200 且 code==1（FR-FWD-04），只读展示。</summary>
    [JsonIgnore]
    public string SuccessRule => "HTTP200 且 code==1";
}

/// <summary>媒体取回与两步式上传配置（§6 媒体组）。</summary>
public sealed class MediaOptions
{
    /// <summary>启用媒体取回转存。</summary>
    public bool EnableRelay { get; set; } = true;

    /// <summary>媒体判定方式。</summary>
    public MediaDetectMode DetectMode { get; set; } = MediaDetectMode.Placeholder;

    /// <summary>媒体占位符列表（占位符判定模式下使用，须非空）。</summary>
    public List<string> Placeholders { get; set; } = new() { "[图片]", "[视频]", "[语音]", "[动画表情]" };

    /// <summary>本地取回方式。</summary>
    public MediaFetchMode FetchMode { get; set; } = MediaFetchMode.LocalFile;

    /// <summary>取回超时（秒，等导出就绪）。</summary>
    public int FetchTimeoutSeconds { get; set; } = 10;

    /// <summary>取回重试次数。</summary>
    public int FetchRetry { get; set; } = 3;

    /// <summary>单文件上限（MB）；上限最终值待确认（§11）。</summary>
    public int MaxFileSizeMb { get; set; } = 50;

    /// <summary>超限处理策略。</summary>
    public OversizePolicy OversizePolicy { get; set; } = OversizePolicy.DeadLetter;

    /// <summary>媒体临时目录（空=用状态目录下默认子目录）。</summary>
    public string? TempDir { get; set; }

    /// <summary>临时文件总量上限（MB；空=不限）。</summary>
    public int? TotalSizeCapMb { get; set; }

    /// <summary>转存方式：契约固定为两步式上传端点（不再 base64/对象存储），只读展示。</summary>
    [JsonIgnore]
    public string TransferMode => "两步式上传端点";
}

/// <summary>拉取补偿配置（§6 补偿组）。</summary>
public sealed class CatchupOptions
{
    /// <summary>启用补偿。</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>触发时机（默认：重连 + 启动 + 定时）。</summary>
    public CatchupTriggers Triggers { get; set; } =
        CatchupTriggers.Reconnect | CatchupTriggers.Startup | CatchupTriggers.Scheduled;

    /// <summary>定时巡检间隔（分钟）。</summary>
    public int IntervalMinutes { get; set; } = 5;

    /// <summary>回溯上限（小时）；超限须告警（FR-REL-08 / FR-SYNC-04）。</summary>
    public int MaxLookbackHours { get; set; } = 24;

    /// <summary>单次补偿最大条数。</summary>
    public int MaxItemsPerRun { get; set; } = 1000;
}

/// <summary>去重配置（§6 去重组）。</summary>
public sealed class DedupOptions
{
    /// <summary>去重表保留时长（小时）。</summary>
    public int RetentionHours { get; set; } = 48;

    /// <summary>去重键：契约固定为 event+rawid（FR-RECV-03），只读展示。</summary>
    [JsonIgnore]
    public string Key => "event+rawid";
}

/// <summary>事件过滤配置（§6 过滤组 / FR-RECV-06）。</summary>
public sealed class FilterOptions
{
    /// <summary>是否转发 message.revoke 撤回事件。</summary>
    public bool ForwardRevoke { get; set; } = true;

    /// <summary>会话白名单（空=不限）。</summary>
    public List<string> SessionAllowList { get; set; } = new();

    /// <summary>会话黑名单（空=不屏蔽）。</summary>
    public List<string> SessionBlockList { get; set; } = new();
}

/// <summary>心跳上报配置（§6 心跳组 / FR-HB-01）。</summary>
public sealed class HeartbeatOptions
{
    /// <summary>启用心跳。</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>心跳端点路径。</summary>
    public string EndpointPath { get; set; } = "/extra_server/weflow/heartbeat";

    /// <summary>心跳间隔（秒）。</summary>
    public int IntervalSeconds { get; set; } = 30;

    /// <summary>状态变更时额外即时上报一次（FR-HB-05）。</summary>
    public bool ReportOnStateChange { get; set; } = true;
}

/// <summary>运行形态配置（§6 运行组 / FR-BOOT）。</summary>
public sealed class RuntimeOptions
{
    /// <summary>开机自启（随登录，写 HKCU\…\Run，FR-BOOT-02）。</summary>
    public bool AutoStart { get; set; } = true;

    /// <summary>启动即最小化到托盘（FR-BOOT-04）。</summary>
    public bool StartMinimized { get; set; } = true;

    /// <summary>关闭窗口=最小化到托盘（FR-UI-04）。</summary>
    public bool CloseToTray { get; set; } = true;
}

/// <summary>初始同步起点配置（§6 同步组 / FR-SYNC-02、06）。</summary>
public sealed class SyncOptions
{
    /// <summary>初始同步策略（首装/无断点时）。默认"从现在开始"，不回灌历史。</summary>
    public InitialSyncStrategy InitialStrategy { get; set; } = InitialSyncStrategy.FromNow;

    /// <summary>初始回溯窗口（小时）；仅"回溯"模式使用。</summary>
    public int? InitialLookbackHours { get; set; }

    /// <summary>指定起点时间；仅"指定时间点"模式使用。</summary>
    public DateTime? SpecifiedStartTime { get; set; }
}

/// <summary>安装与本地状态配置（§6 安装组 / FR-SYNC-07）。</summary>
public sealed class InstallOptions
{
    /// <summary>本地状态存储位置（与二进制分离、免提权）。</summary>
    public string StateStorageLocation { get; set; } = @"%LocalAppData%\WeflowAgent";

    /// <summary>卸载时本地状态处理。</summary>
    public UninstallStatePolicy UninstallStatePolicy { get; set; } = UninstallStatePolicy.Keep;

    /// <summary>交付/自启形态：契约固定为绿色版+自注册（FR-SYNC-07），只读展示。</summary>
    [JsonIgnore]
    public string DeliveryForm => "绿色版+自注册";
}

/// <summary>日志配置（§6 日志组 / FR-LOG）。</summary>
public sealed class LoggingOptions
{
    /// <summary>日志级别。</summary>
    public LogLevel Level { get; set; } = LogLevel.Info;

    /// <summary>保留天数。</summary>
    public int RetentionDays { get; set; } = 30;

    /// <summary>单文件上限（MB）。</summary>
    public int MaxFileSizeMb { get; set; } = 20;
}

/// <summary>高级配置（§6 高级组）。</summary>
public sealed class AdvancedOptions
{
    /// <summary>演练模式（Dry-run）：完成接收/媒体取回/处理与日志，但不真正发下游（FR-TEST-08）。</summary>
    public bool DryRun { get; set; } = false;
}

/// <summary>
/// 非敏感配置根模型，落盘为 config.json。带 schemaVersion 以支持版本升级平滑迁移（FR-SYNC-09）。
/// </summary>
public sealed class AgentConfig
{
    /// <summary>本地存储模式版本；启动时据此决定是否迁移。初版为 1。</summary>
    public int SchemaVersion { get; set; } = 1;

    public WeFlowOptions WeFlow { get; set; } = new();
    public DownstreamOptions Downstream { get; set; } = new();
    public MediaOptions Media { get; set; } = new();
    public CatchupOptions Catchup { get; set; } = new();
    public DedupOptions Dedup { get; set; } = new();
    public FilterOptions Filter { get; set; } = new();
    public HeartbeatOptions Heartbeat { get; set; } = new();
    public RuntimeOptions Runtime { get; set; } = new();
    public SyncOptions Sync { get; set; } = new();
    public InstallOptions Install { get; set; } = new();
    public LoggingOptions Logging { get; set; } = new();
    public AdvancedOptions Advanced { get; set; } = new();
}
