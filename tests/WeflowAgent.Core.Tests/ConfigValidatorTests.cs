using System.Linq;                        // Any
using WeflowAgent.Core.Configuration;     // AgentConfig、ConfigValidator、ValidationResult
using WeflowAgent.Core.Security;          // CredentialSet

namespace WeflowAgent.Core.Tests;

// ── 本文件验证什么 ───────────────────────────────────────────────────────────
// ConfigValidator 在"保存"时统一校验配置 + 凭据（FR-CFG-02）。校验四类：
//   URL（BaseUrl 须 https、HostPort 格式）、必填（BaseUrl/siteKey/AES 密钥）、
//   数值范围（超时/间隔等 >0）、AES 密钥长度（≥16 字节，FR-AUTH-02 取前 16 字节）。
// 校验结果 ValidationResult 含 IsValid 与 Errors（每条带 Field 路径，供界面定位到对应分组/字段）。
public class ConfigValidatorTests
{
    // 造一份"完全合法"的配置 + 凭据基线；各测试在其上改坏一处，验证恰好报对应错误。
    private static AgentConfig ValidConfig()
    {
        var c = new AgentConfig();
        c.Downstream.BaseUrl = "https://wo.example.com";   // 必填 + https
        return c;   // 其余数值字段默认即合法（皆 >0）
    }

    private static CredentialSet ValidCredentials() => new()
    {
        WeflowAccessToken = "weflow-token",
        DownstreamSiteKey = "weflow-agent-sitekey",
        DownstreamAesKey = "0123456789abcdef",   // 16 字节，满足 AES-128 取前 16 字节
    };

    private static bool HasError(ValidationResult r, string field) =>
        r.Errors.Any(e => e.Field == field);

    [Fact]
    public void Valid_config_and_credentials_pass()
    {
        var result = new ConfigValidator().Validate(ValidConfig(), ValidCredentials());

        Assert.True(result.IsValid);
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void Missing_required_fields_are_reported()
    {
        // 默认配置 BaseUrl 为 null；空凭据三项皆 null —— 三件套联调前置缺失。
        var result = new ConfigValidator().Validate(new AgentConfig(), new CredentialSet());

        Assert.False(result.IsValid);
        Assert.True(HasError(result, "Downstream.BaseUrl"));
        Assert.True(HasError(result, "Downstream.SiteKey"));
        Assert.True(HasError(result, "Downstream.AesKey"));
    }

    [Fact]
    public void BaseUrl_must_be_https()
    {
        var cfg = ValidConfig();
        cfg.Downstream.BaseUrl = "http://wo.example.com";   // 非 https（FR-SEC-02 强制 HTTPS）

        var result = new ConfigValidator().Validate(cfg, ValidCredentials());

        Assert.False(result.IsValid);
        Assert.True(HasError(result, "Downstream.BaseUrl"));
    }

    [Fact]
    public void AesKey_shorter_than_16_bytes_is_rejected()
    {
        var creds = ValidCredentials();
        creds.DownstreamAesKey = "0123456789abcde";   // 15 字节，不足 16

        var result = new ConfigValidator().Validate(ValidConfig(), creds);

        Assert.False(result.IsValid);
        Assert.True(HasError(result, "Downstream.AesKey"));
    }

    [Fact]
    public void AesKey_with_exactly_16_bytes_passes_the_length_rule()
    {
        var creds = ValidCredentials();
        creds.DownstreamAesKey = "abcdefghijklmnop";   // 正好 16 字节

        var result = new ConfigValidator().Validate(ValidConfig(), creds);

        // 不应有 AesKey 相关错误（其它项也都合法 → 整体通过）。
        Assert.False(HasError(result, "Downstream.AesKey"));
        Assert.True(result.IsValid);
    }

    [Fact]
    public void Non_positive_numeric_values_are_rejected()
    {
        var cfg = ValidConfig();
        cfg.WeFlow.ReadTimeoutSeconds = 0;          // 必须 >0
        cfg.Downstream.RequestTimeoutSeconds = -1;  // 必须 >0

        var result = new ConfigValidator().Validate(cfg, ValidCredentials());

        Assert.False(result.IsValid);
        Assert.True(HasError(result, "WeFlow.ReadTimeoutSeconds"));
        Assert.True(HasError(result, "Downstream.RequestTimeoutSeconds"));
    }

    [Fact]
    public void Malformed_host_port_is_rejected()
    {
        var cfg = ValidConfig();
        cfg.WeFlow.HostPort = "not-a-host-port";   // 缺端口

        var result = new ConfigValidator().Validate(cfg, ValidCredentials());

        Assert.False(result.IsValid);
        Assert.True(HasError(result, "WeFlow.HostPort"));
    }
}
