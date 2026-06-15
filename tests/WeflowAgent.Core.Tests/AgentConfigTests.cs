using System;                            // DateTime?（同步起点）
using System.Linq;                        // SequenceEqual（比较占位符列表）
using WeflowAgent.Core.Configuration;     // 被测对象：AgentConfig 及各 *Options / 枚举

namespace WeflowAgent.Core.Tests;

// ── 本文件验证什么 ───────────────────────────────────────────────────────────
// AgentConfig 是"非敏感配置"的根模型，对应 SRS §6 配置项清单的十余个分组。
// 设计要求：`new AgentConfig()` 直接就是一份"合理默认配置"（取自 §6 的"示例/默认"列），
// 这样 ConfigStore 首次无文件时返回 new AgentConfig() 即可，且 JSON 反序列化缺字段也回落到默认值。
// 下面按分组逐一断言默认值是否与 §6 一致；这就是第 1 步要锁定的"行为"。
public class AgentConfigTests
{
    [Fact]
    public void WeFlow_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.Equal("127.0.0.1:5031", c.WeFlow.HostPort);
        Assert.Equal("/api/v1/push/messages", c.WeFlow.SsePath);
        Assert.Equal(60, c.WeFlow.ReadTimeoutSeconds);
        Assert.Equal(1, c.WeFlow.ReconnectBackoffStartSeconds);
        Assert.Equal(30, c.WeFlow.ReconnectBackoffMaxSeconds);
        Assert.Equal(0, c.WeFlow.MaxReconnectAttempts);   // 0 = 无限重连
        Assert.Equal(30, c.WeFlow.HealthIntervalSeconds);
    }

    [Fact]
    public void Downstream_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.Null(c.Downstream.BaseUrl);                // 待提供，默认空 → 校验时必填
        Assert.True(c.Downstream.RealtimeTokenGeneration);
        Assert.Equal(15, c.Downstream.RequestTimeoutSeconds);
        Assert.Equal(3, c.Downstream.RetryCount);
        Assert.Equal(2, c.Downstream.RetryBackoffSeconds);
        // 成功判定为契约固定值（只读展示，不可编辑）。
        Assert.Equal("HTTP200 且 code==1", c.Downstream.SuccessRule);
    }

    [Fact]
    public void Media_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.True(c.Media.EnableRelay);
        Assert.Equal(MediaDetectMode.Placeholder, c.Media.DetectMode);
        Assert.True(new[] { "[图片]", "[视频]", "[语音]", "[动画表情]" }
            .SequenceEqual(c.Media.Placeholders));
        Assert.Equal(MediaFetchMode.LocalFile, c.Media.FetchMode);
        Assert.Equal(10, c.Media.FetchTimeoutSeconds);
        Assert.Equal(3, c.Media.FetchRetry);
        Assert.Equal(50, c.Media.MaxFileSizeMb);          // 上限待最终确认（§11）
        Assert.Equal(OversizePolicy.DeadLetter, c.Media.OversizePolicy);
        // 转存方式为契约固定值。
        Assert.Equal("两步式上传端点", c.Media.TransferMode);
    }

    [Fact]
    public void Catchup_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.True(c.Catchup.Enabled);
        // 默认触发时机 = 重连 + 启动 + 定时（三者位或）。
        Assert.Equal(
            CatchupTriggers.Reconnect | CatchupTriggers.Startup | CatchupTriggers.Scheduled,
            c.Catchup.Triggers);
        Assert.Equal(5, c.Catchup.IntervalMinutes);
        Assert.Equal(24, c.Catchup.MaxLookbackHours);
        Assert.Equal(1000, c.Catchup.MaxItemsPerRun);
    }

    [Fact]
    public void Dedup_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.Equal(48, c.Dedup.RetentionHours);
        Assert.Equal("event+rawid", c.Dedup.Key);         // 契约固定
    }

    [Fact]
    public void Filter_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.True(c.Filter.ForwardRevoke);              // 默认转发撤回事件
        Assert.Empty(c.Filter.SessionAllowList);
        Assert.Empty(c.Filter.SessionBlockList);
    }

    [Fact]
    public void Heartbeat_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.True(c.Heartbeat.Enabled);
        Assert.Equal("/extra_server/weflow/heartbeat", c.Heartbeat.EndpointPath);
        Assert.Equal(30, c.Heartbeat.IntervalSeconds);
        Assert.True(c.Heartbeat.ReportOnStateChange);
    }

    [Fact]
    public void Runtime_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.True(c.Runtime.AutoStart);                 // 开机自启
        Assert.True(c.Runtime.StartMinimized);
        Assert.True(c.Runtime.CloseToTray);
    }

    [Fact]
    public void Sync_defaults_match_section6()
    {
        var c = new AgentConfig();
        // 默认"从现在开始"——只转发首启后的新消息，严禁全量回灌历史（FR-SYNC-02）。
        Assert.Equal(InitialSyncStrategy.FromNow, c.Sync.InitialStrategy);
        Assert.Null(c.Sync.InitialLookbackHours);         // 仅"回溯"模式才用
        Assert.Null(c.Sync.SpecifiedStartTime);           // 仅"指定时间点"模式才用
    }

    [Fact]
    public void Install_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.Equal(@"%LocalAppData%\WeflowAgent", c.Install.StateStorageLocation);
        Assert.Equal(UninstallStatePolicy.Keep, c.Install.UninstallStatePolicy);
        Assert.Equal("绿色版+自注册", c.Install.DeliveryForm);   // 契约固定
    }

    [Fact]
    public void Logging_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.Equal(LogLevel.Info, c.Logging.Level);
        Assert.Equal(30, c.Logging.RetentionDays);
        Assert.Equal(20, c.Logging.MaxFileSizeMb);
    }

    [Fact]
    public void Advanced_defaults_match_section6()
    {
        var c = new AgentConfig();
        Assert.False(c.Advanced.DryRun);                  // 演练模式默认关
    }

    [Fact]
    public void Root_carries_schema_version_and_non_null_groups()
    {
        var c = new AgentConfig();
        Assert.Equal(1, c.SchemaVersion);                 // 初版 schemaVersion = 1（FR-SYNC-09）
        // 各分组子对象都应已初始化（非 null），调用方可直接读写而不必判空。
        Assert.NotNull(c.WeFlow);
        Assert.NotNull(c.Downstream);
        Assert.NotNull(c.Media);
        Assert.NotNull(c.Catchup);
        Assert.NotNull(c.Dedup);
        Assert.NotNull(c.Filter);
        Assert.NotNull(c.Heartbeat);
        Assert.NotNull(c.Runtime);
        Assert.NotNull(c.Sync);
        Assert.NotNull(c.Install);
        Assert.NotNull(c.Logging);
        Assert.NotNull(c.Advanced);
    }
}
