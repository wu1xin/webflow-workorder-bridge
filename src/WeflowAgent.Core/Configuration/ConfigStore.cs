using System.IO;                          // File（读写文件文本）
using System.Text.Json;                    // JsonSerializer、JsonSerializerOptions
using System.Text.Json.Serialization;      // JsonStringEnumConverter（枚举存为名字）

namespace WeflowAgent.Core.Configuration;

/// <summary>
/// 非敏感配置（<see cref="AgentConfig"/>）在 config.json 上的存取。
/// <para>
/// 首次无文件时返回一份默认配置；落盘为缩进、枚举存名字的可读 JSON。
/// </para>
/// <para>
/// 关于版本迁移（FR-SYNC-09）：配置带 <see cref="AgentConfig.SchemaVersion"/> 字段并随往返保真。
/// 当前 schema 即 v1、无 v1→v2 迁移步骤，故首版不触发迁移；待 schema 演进时，由独立的
/// <see cref="Persistence.SchemaMigrator"/>（已实现并测试，逐级迁移 + 失败不静默覆盖）接入。
/// </para>
/// </summary>
public sealed class ConfigStore
{
    private readonly string _configFilePath;

    // 序列化选项做成静态只读，全实例共享：
    //  · WriteIndented            ——缩进，便于人工查看/排错。
    //  · PropertyNamingPolicy     ——camelCase，符合 JSON 习惯（schemaVersion、weFlow…）。
    //  · JsonStringEnumConverter  ——枚举存为名字（"Placeholder"）而非数字；[Flags] 存为逗号分隔，
    //                               可读且对增删枚举值更稳健。
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() },
    };

    public ConfigStore(string configFilePath)
    {
        _configFilePath = configFilePath;
    }

    /// <summary>读取配置；文件不存在则返回默认配置（供首启使用）。</summary>
    public AgentConfig Load()
    {
        // 首次无文件 → 一份默认配置即可（new AgentConfig() 各字段已是 §6 默认值）。
        if (!File.Exists(_configFilePath))
            return new AgentConfig();

        string json = File.ReadAllText(_configFilePath);
        // 反序列化；理论上空文件/内容为 "null" 时结果可能为 null，则回落到默认配置。
        AgentConfig? config = JsonSerializer.Deserialize<AgentConfig>(json, SerializerOptions);
        return config ?? new AgentConfig();
    }

    /// <summary>把配置序列化为可读 JSON 写入磁盘（已存在则覆盖）。</summary>
    public void Save(AgentConfig config)
    {
        string json = JsonSerializer.Serialize(config, SerializerOptions);
        File.WriteAllText(_configFilePath, json);
    }
}
