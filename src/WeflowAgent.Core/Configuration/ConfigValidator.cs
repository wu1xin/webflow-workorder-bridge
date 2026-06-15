using System;                          // Uri
using System.Collections.Generic;       // List、IReadOnlyList
using System.Text;                       // Encoding（按字节数算 AES 密钥长度）
using WeflowAgent.Core.Security;         // CredentialSet（敏感三项在此）

namespace WeflowAgent.Core.Configuration;

/// <summary>一条字段级校验错误：<see cref="Field"/> 是"分组.字段"路径，供界面定位到对应分组/控件。</summary>
public sealed class FieldError
{
    public FieldError(string field, string message)
    {
        Field = field;
        Message = message;
    }

    /// <summary>字段路径，如 <c>Downstream.BaseUrl</c>。</summary>
    public string Field { get; }

    /// <summary>给用户看的中文提示。</summary>
    public string Message { get; }
}

/// <summary>配置校验结果：错误清单为空即视为通过。</summary>
public sealed class ValidationResult
{
    public ValidationResult(IReadOnlyList<FieldError> errors)
    {
        Errors = errors;
    }

    public IReadOnlyList<FieldError> Errors { get; }

    /// <summary>无任何错误即合法。</summary>
    public bool IsValid => Errors.Count == 0;
}

/// <summary>
/// 配置 + 凭据的保存前校验（FR-CFG-02）：URL（https/host:port）、必填（BaseUrl/siteKey/AES）、
/// 数值范围（关键项 &gt;0）、AES 密钥长度（≥16 字节，FR-AUTH-02 取前 16 字节）。
/// </summary>
public sealed class ConfigValidator
{
    /// <summary>校验配置与凭据；返回所有发现的问题（不抛异常，便于界面一次性展示全部）。</summary>
    public ValidationResult Validate(AgentConfig config, CredentialSet credentials)
    {
        var errors = new List<FieldError>();

        // 局部函数：捕获上面的 errors 列表，少写样板。
        void Add(string field, string message) => errors.Add(new FieldError(field, message));
        void RequirePositive(int value, string field)
        {
            if (value <= 0) Add(field, $"{field} 必须大于 0。");
        }

        // ── 下游 Base URL：必填 + 必须 https（FR-SEC-02 强制 HTTPS）──
        string? baseUrl = config.Downstream.BaseUrl;
        if (string.IsNullOrWhiteSpace(baseUrl))
            Add("Downstream.BaseUrl", "下游 Base URL 必填。");
        else if (!IsHttpsUrl(baseUrl))
            Add("Downstream.BaseUrl", "下游 Base URL 必须为 https:// 开头的合法地址。");

        // ── site key：必填 ──
        if (string.IsNullOrWhiteSpace(credentials.DownstreamSiteKey))
            Add("Downstream.SiteKey", "site key 必填。");

        // ── AES 密钥：必填 + ≥16 字节（取前 16 字节作 AES-128 密钥）──
        string? aes = credentials.DownstreamAesKey;
        if (string.IsNullOrWhiteSpace(aes))
            Add("Downstream.AesKey", "AES 密钥必填。");
        else if (Encoding.UTF8.GetByteCount(aes) < 16)
            Add("Downstream.AesKey", "AES 密钥至少 16 字节（取前 16 字节作 AES-128 密钥）。");

        // ── WeFlow 地址：host:port 格式 ──
        if (!IsValidHostPort(config.WeFlow.HostPort))
            Add("WeFlow.HostPort", "WeFlow 地址须为 host:port 格式（端口 1-65535）。");

        // ── 关键数值范围：超时/间隔/上限等须 >0 ──
        RequirePositive(config.WeFlow.ReadTimeoutSeconds, "WeFlow.ReadTimeoutSeconds");
        RequirePositive(config.WeFlow.HealthIntervalSeconds, "WeFlow.HealthIntervalSeconds");
        RequirePositive(config.Downstream.RequestTimeoutSeconds, "Downstream.RequestTimeoutSeconds");
        RequirePositive(config.Media.FetchTimeoutSeconds, "Media.FetchTimeoutSeconds");
        RequirePositive(config.Media.MaxFileSizeMb, "Media.MaxFileSizeMb");
        RequirePositive(config.Catchup.IntervalMinutes, "Catchup.IntervalMinutes");
        RequirePositive(config.Catchup.MaxLookbackHours, "Catchup.MaxLookbackHours");
        RequirePositive(config.Catchup.MaxItemsPerRun, "Catchup.MaxItemsPerRun");
        RequirePositive(config.Dedup.RetentionHours, "Dedup.RetentionHours");
        RequirePositive(config.Heartbeat.IntervalSeconds, "Heartbeat.IntervalSeconds");
        RequirePositive(config.Logging.RetentionDays, "Logging.RetentionDays");
        RequirePositive(config.Logging.MaxFileSizeMb, "Logging.MaxFileSizeMb");

        // 重试次数允许为 0（不重试），但不能为负。
        if (config.Downstream.RetryCount < 0)
            Add("Downstream.RetryCount", "重试次数不能为负。");

        // ── 占位符判定模式下，占位符列表不能为空 ──
        if (config.Media.DetectMode == MediaDetectMode.Placeholder && config.Media.Placeholders.Count == 0)
            Add("Media.Placeholders", "占位符判定模式下，占位符列表不能为空。");

        return new ValidationResult(errors);
    }

    // 合法的 https 绝对地址。
    private static bool IsHttpsUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out Uri? u) && u.Scheme == Uri.UriSchemeHttps;

    // host:port 格式：恰好一个冒号，host 非空，port 为 1-65535 的整数。
    private static bool IsValidHostPort(string? hostPort)
    {
        if (string.IsNullOrWhiteSpace(hostPort)) return false;
        string[] parts = hostPort.Split(':');
        if (parts.Length != 2) return false;
        if (string.IsNullOrWhiteSpace(parts[0])) return false;
        return int.TryParse(parts[1], out int port) && port is >= 1 and <= 65535;
    }
}
