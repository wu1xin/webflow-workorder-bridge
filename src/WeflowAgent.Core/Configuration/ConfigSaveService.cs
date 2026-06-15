using WeflowAgent.Core.Security;   // CredentialSet、CredentialStore

namespace WeflowAgent.Core.Configuration;

/// <summary>保存结果：是否已落盘 + 本次校验详情（失败时含字段级错误供界面展示）。</summary>
public sealed class ConfigSaveResult
{
    public ConfigSaveResult(bool saved, ValidationResult validation)
    {
        Saved = saved;
        Validation = validation;
    }

    /// <summary>是否已写入磁盘（仅校验通过时为 true）。</summary>
    public bool Saved { get; }

    /// <summary>本次校验结果（无论成败都带上）。</summary>
    public ValidationResult Validation { get; }
}

/// <summary>
/// "保存配置"的编排内核（界面点保存时调用）：先校验，不通过则一字不写、返回错误；
/// 通过则双路落盘——非敏感 → config.json（<see cref="ConfigStore"/>）、敏感三项 → secrets.dat
/// （<see cref="CredentialStore"/>，DPAPI 加密）。把这段逻辑放 Core 便于单测，界面只管收集值与展示结果。
/// </summary>
public sealed class ConfigSaveService
{
    private readonly ConfigStore _configStore;
    private readonly CredentialStore _credentialStore;
    private readonly ConfigValidator _validator;

    public ConfigSaveService(ConfigStore configStore, CredentialStore credentialStore, ConfigValidator validator)
    {
        _configStore = configStore;
        _credentialStore = credentialStore;
        _validator = validator;
    }

    /// <summary>校验并保存；校验失败时不落盘（避免写入半截/非法配置）。</summary>
    public ConfigSaveResult Save(AgentConfig config, CredentialSet credentials)
    {
        ValidationResult validation = _validator.Validate(config, credentials);
        if (!validation.IsValid)
            return new ConfigSaveResult(saved: false, validation);

        _configStore.Save(config);
        _credentialStore.Save(credentials);
        return new ConfigSaveResult(saved: true, validation);
    }
}
