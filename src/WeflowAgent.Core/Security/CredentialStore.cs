using System;                       // （基础类型）
using System.IO;                     // File（读写文件字节）
using System.Security.Cryptography;  // CryptographicException（解密失败异常）
using System.Text.Json;              // JsonSerializer（对象 ↔ JSON 文本 的序列化）

namespace WeflowAgent.Core.Security;

/// <summary>凭据加载结果状态。</summary>
// 一个枚举，表示"尝试加载凭据"后可能落到的三种结局。
public enum CredentialLoadStatus
{
    /// <summary>secrets 文件不存在（首装 / 未录入）。</summary>
    Missing,

    /// <summary>成功加载并解密。</summary>
    Loaded,

    /// <summary>
    /// 文件在、但 DPAPI 解密失败——几乎可判定为换机/换用户（见 SRS FR-SYNC-01），
    /// 上层应提示"重新录入凭据"而非静默报错。
    /// </summary>
    Undecryptable,
}

/// <summary>线下安全获取、需 DPAPI 加密存储的敏感凭据集合。</summary>
//
// 一个纯数据类（DTO）：只用来装几项凭据字段。
public sealed class CredentialSet
{
    // `string?` 的问号表示"可空"：这些字段允许为 null（还没录入时就是空的）。
    // `{ get; set; }` = "可读可写自动属性"：既能读也能赋值（区别于 AppPaths 里的只读 `{ get; }`）。
    /// <summary>WeFlow 本机 SSE 的 access_token。</summary>
    public string? WeflowAccessToken { get; set; }

    /// <summary>下游 task_white_token 的 AES 密钥（取前 16 字节）。</summary>
    public string? DownstreamAesKey { get; set; }

    /// <summary>下游 site key。</summary>
    public string? DownstreamSiteKey { get; set; }
}

/// <summary>凭据加载结果。</summary>
//
// 把"状态 + （可能为空的）凭据数据"打包返回。
public sealed class CredentialLoadResult
{
    // 构造函数。参数 `CredentialSet? credentials = null`：可空且有默认值 null，
    //   所以调用时可以只传 status（如 Missing/Undecryptable 时根本没有凭据可带）。
    public CredentialLoadResult(CredentialLoadStatus status, CredentialSet? credentials = null)
    {
        Status = status;
        Credentials = credentials;
    }

    public CredentialLoadStatus Status { get; }

    public CredentialSet? Credentials { get; }   // 只有 Loaded 时才非空
}

/// <summary>
/// 敏感凭据的本地存储：序列化为 JSON 后经 DPAPI 加密落到 secrets 文件。
/// </summary>
public sealed class CredentialStore
{
    // 两个私有只读字段：要写入的文件路径、以及用来加解密的工具对象。
    // 它们由构造函数从外部传入（依赖注入），便于测试时替换。
    private readonly string _secretsFilePath;
    private readonly DpapiCredentialProtector _protector;

    public CredentialStore(string secretsFilePath, DpapiCredentialProtector protector)
    {
        _secretsFilePath = secretsFilePath;
        _protector = protector;
    }

    // 保存流程：对象 → JSON 文本 → 加密成字节 → 写入文件。
    public void Save(CredentialSet credentials)
    {
        // JsonSerializer.Serialize(对象) 把对象转成 JSON 字符串，如 {"WeflowAccessToken":"..."}。
        string json = JsonSerializer.Serialize(credentials);
        byte[] cipher = _protector.Protect(json);       // 再用 DPAPI 加密成密文字节
        File.WriteAllBytes(_secretsFilePath, cipher);    // 一次性把字节写入文件（已存在则覆盖）
    }

    // 加载流程：是 Save 的逆过程，且每一步都考虑了"可能出错"的情况。
    public CredentialLoadResult Load()
    {
        // 文件不存在 → 还没录入过，返回 Missing（注意只传一个参数，credentials 用默认 null）。
        if (!File.Exists(_secretsFilePath))             // ! 是逻辑取反："如果文件不存在"
            return new CredentialLoadResult(CredentialLoadStatus.Missing);

        byte[] cipher = File.ReadAllBytes(_secretsFilePath);   // 读出密文字节
        string json;                                            // 先声明，下面在 try 里赋值
        // try/catch：把"可能抛异常的代码"放进 try，若真抛出对应异常就跳到 catch 处理，
        // 从而避免程序直接崩溃。这是 C# 处理错误的标准机制。
        try
        {
            json = _protector.Unprotect(cipher);        // 尝试解密；换机/损坏会在此抛异常
        }
        catch (CryptographicException)                  // 只捕获"解密失败"这一种异常
        {
            // 解不开 = 换机/换用户/文件损坏 → 交由上层引导重新录入。
            return new CredentialLoadResult(CredentialLoadStatus.Undecryptable);
        }

        // 走到这里说明解密成功。把 JSON 文本反序列化回 CredentialSet 对象。
        // `Deserialize<CredentialSet>` 里的 <CredentialSet> 是泛型参数：告诉它"解析成这个类型"。
        // 返回类型是 `CredentialSet?`（可空），因为 JSON 内容理论上可能是 "null"。
        CredentialSet? set = JsonSerializer.Deserialize<CredentialSet>(json);
        return new CredentialLoadResult(CredentialLoadStatus.Loaded, set);
    }
}
