using System;                            // Guid
using System.IO;                          // Path、Directory、File
using WeflowAgent.Core.Configuration;     // AgentConfig、ConfigStore、ConfigValidator、ConfigSaveService
using WeflowAgent.Core.Security;          // CredentialSet、CredentialStore、DpapiCredentialProtector

namespace WeflowAgent.Core.Tests;

// ── 本文件验证什么 ───────────────────────────────────────────────────────────
// ConfigSaveService 是"保存配置"的编排内核（界面点保存时调用它）：
//   先校验 → 不通过则一字不写、原样返回校验错误；通过则双路落盘（config.json + secrets.dat）。
// 把这段逻辑放 Core 用真实存储 + 真实 DPAPI 跑，界面 code-behind 只管收集值与展示结果。
public class ConfigSaveServiceTests
{
    // 在唯一临时目录里搭一套真实的 store + validator（用后删目录）。
    private static (ConfigSaveService service, string dir, string configPath, string secretsPath) NewService()
    {
        string dir = Path.Combine(Path.GetTempPath(), "weflow-save-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        string configPath = Path.Combine(dir, "config.json");
        string secretsPath = Path.Combine(dir, "secrets.dat");
        var service = new ConfigSaveService(
            new ConfigStore(configPath),
            new CredentialStore(secretsPath, new DpapiCredentialProtector()),
            new ConfigValidator());
        return (service, dir, configPath, secretsPath);
    }

    private static CredentialSet ValidCredentials() => new()
    {
        WeflowAccessToken = "weflow-token",
        DownstreamSiteKey = "weflow-agent-sitekey",
        DownstreamAesKey = "0123456789abcdef",
    };

    [Fact]
    public void Invalid_input_is_not_persisted_and_returns_errors()
    {
        var (service, dir, configPath, secretsPath) = NewService();
        try
        {
            // 默认配置 BaseUrl=null、空凭据 → 校验必然失败。
            ConfigSaveResult result = service.Save(new AgentConfig(), new CredentialSet());

            Assert.False(result.Saved);
            Assert.False(result.Validation.IsValid);
            Assert.NotEmpty(result.Validation.Errors);
            // 校验失败时一字不写，避免把半截/非法配置落盘。
            Assert.False(File.Exists(configPath));
            Assert.False(File.Exists(secretsPath));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Valid_input_is_persisted_to_both_files()
    {
        var (service, dir, configPath, secretsPath) = NewService();
        try
        {
            var cfg = new AgentConfig();
            cfg.Downstream.BaseUrl = "https://wo.example.com";

            ConfigSaveResult result = service.Save(cfg, ValidCredentials());

            Assert.True(result.Saved);
            Assert.True(result.Validation.IsValid);
            // 双路都应落盘。
            Assert.True(File.Exists(configPath));
            Assert.True(File.Exists(secretsPath));
            // 再读回 config，确认内容确实持久化。
            AgentConfig reloaded = new ConfigStore(configPath).Load();
            Assert.Equal("https://wo.example.com", reloaded.Downstream.BaseUrl);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }
}
