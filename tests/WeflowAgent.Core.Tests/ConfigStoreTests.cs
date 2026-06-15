using System;                            // Guid
using System.IO;                          // Path、File、Directory
using System.Linq;                        // SequenceEqual
using WeflowAgent.Core.Configuration;     // AgentConfig、ConfigStore、各枚举

namespace WeflowAgent.Core.Tests;

// ── 本文件验证什么 ───────────────────────────────────────────────────────────
// ConfigStore 负责把 AgentConfig 在 config.json 上存取（明文，非敏感）。要点：
//  · 首次无文件 → 返回一份默认 AgentConfig（供首启使用）。
//  · Save 后 Load 应原样取回（往返保真），尤其要覆盖嵌套对象、枚举、[Flags]、列表、可空字段。
//  · 落盘的 config.json 须人类可读（缩进 + 枚举存为名字而非数字）。
public class ConfigStoreTests
{
    // 造一个不存在的临时文件路径（带唯一后缀，避免和其它测试/上次运行撞车）。
    private static string TempConfigPath() =>
        Path.Combine(Path.GetTempPath(), "weflow-config-" + Guid.NewGuid().ToString("N") + ".json");

    [Fact]
    public void Load_returns_default_config_when_file_missing()
    {
        var path = TempConfigPath();   // 注意：故意不创建该文件
        var store = new ConfigStore(path);

        AgentConfig cfg = store.Load();

        // 应拿到一份默认配置（而非 null），抽查两个有代表性的默认值即可。
        Assert.NotNull(cfg);
        Assert.Equal(1, cfg.SchemaVersion);
        Assert.Equal("127.0.0.1:5031", cfg.WeFlow.HostPort);
    }

    [Fact]
    public void Save_then_Load_round_trips_all_field_kinds()
    {
        var path = TempConfigPath();
        try
        {
            var store = new ConfigStore(path);

            // 准备一份"改过多处、覆盖各种字段形态"的配置。
            var original = new AgentConfig();
            original.WeFlow.HostPort = "10.0.0.5:6000";                 // 普通字符串
            original.WeFlow.ReadTimeoutSeconds = 90;                    // 整数
            original.Downstream.BaseUrl = "https://wo.example.com";     // 可空字符串（赋值）
            original.Downstream.RetryCount = 7;
            original.Media.DetectMode = MediaDetectMode.PerMessageProbe; // 普通枚举
            original.Media.Placeholders = new() { "[图片]", "[文件]" };   // 列表
            original.Media.TotalSizeCapMb = 512;                        // 可空整数（赋值）
            original.Catchup.Triggers =
                CatchupTriggers.Reconnect | CatchupTriggers.Scheduled;  // [Flags] 组合
            original.Sync.InitialStrategy = InitialSyncStrategy.LookbackHours;
            original.Sync.InitialLookbackHours = 6;
            original.Logging.Level = LogLevel.Debug;
            original.Advanced.DryRun = true;                            // 布尔

            store.Save(original);
            AgentConfig loaded = store.Load();

            Assert.Equal("10.0.0.5:6000", loaded.WeFlow.HostPort);
            Assert.Equal(90, loaded.WeFlow.ReadTimeoutSeconds);
            Assert.Equal("https://wo.example.com", loaded.Downstream.BaseUrl);
            Assert.Equal(7, loaded.Downstream.RetryCount);
            Assert.Equal(MediaDetectMode.PerMessageProbe, loaded.Media.DetectMode);
            Assert.True(new[] { "[图片]", "[文件]" }.SequenceEqual(loaded.Media.Placeholders));
            Assert.Equal(512, loaded.Media.TotalSizeCapMb);
            Assert.Equal(CatchupTriggers.Reconnect | CatchupTriggers.Scheduled, loaded.Catchup.Triggers);
            Assert.Equal(InitialSyncStrategy.LookbackHours, loaded.Sync.InitialStrategy);
            Assert.Equal(6, loaded.Sync.InitialLookbackHours);
            Assert.Equal(LogLevel.Debug, loaded.Logging.Level);
            Assert.True(loaded.Advanced.DryRun);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void Save_writes_human_readable_json_with_named_enums()
    {
        var path = TempConfigPath();
        try
        {
            var store = new ConfigStore(path);
            store.Save(new AgentConfig());

            string text = File.ReadAllText(path);
            // 缩进过的 JSON 会带 schemaVersion 字段。
            Assert.Contains("schemaVersion", text);
            // 枚举应存为名字（可读、稳健），而非数字 0/1。默认 DetectMode=Placeholder。
            Assert.Contains("Placeholder", text);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}
