using System.Security.Cryptography;   // ProtectedData（Windows DPAPI 封装）、CryptographicException
using System.Text;                     // Encoding（字符串 ↔ 字节数组 的编码转换）

// 注意命名空间多了一截 .Security，对应文件所在的 Security 子文件夹（约定俗成，但非强制）。
namespace WeflowAgent.Core.Security;

/// <summary>
/// 基于 Windows DPAPI（CurrentUser 范围）的凭据加解密。
/// 密文绑定到"当前 Windows 用户 + 本机"——换机/换用户后解密会失败，
/// 这一失败正是"换机识别信号"（见 SRS FR-SYNC-01）。
/// </summary>
//
// 背景知识：DPAPI = Windows 数据保护接口。它用"当前用户登录态派生出的密钥"来加解密，
// 密钥由系统托管、不落在我们的代码里。好处是：我们无需自己保管主密钥；坏处（这里反成优点）
// 是换台机器/换个用户后就解不开——正好可用来侦测"用户换机了"。
public sealed class DpapiCredentialProtector
{
    // 固定的应用级熵，增加一层与本应用绑定的盐。
    //
    // `private static readonly byte[] Entropy`：
    //   · static    = 属于"类"而非每个对象，全程序共享同一份。
    //   · readonly  = 只读，只能在声明处或构造函数里赋值一次，之后不可改（防止被意外篡改）。
    //   · byte[]    = "字节数组"，[] 表示数组。字节是 0~255 的整数，加密 API 都以字节为单位工作。
    // Encoding.UTF8.GetBytes("...") 把这串文本按 UTF-8 编码转成字节数组。
    // 这个"熵/盐"会和用户密钥一起参与加解密：相当于额外加一把"本应用专属的锁"，
    // 解密时必须提供同样的熵才能解开。
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WeflowAgent.Credentials.v1");

    /// <summary>将明文加密为 DPAPI 密文。</summary>
    // 入参是明文字符串，返回加密后的字节数组（密文）。
    public byte[] Protect(string plaintext)
    {
        byte[] data = Encoding.UTF8.GetBytes(plaintext);   // 先把文本转成字节（加密只认字节）
        // ProtectedData.Protect(数据, 熵, 范围) 执行 DPAPI 加密。
        // DataProtectionScope.CurrentUser = 用"当前用户"范围的密钥（仅本用户能解）；
        //   另有 LocalMachine（本机所有用户都能解）——这里要绑定到用户，故选 CurrentUser。
        return ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser);
    }

    /// <summary>解密 DPAPI 密文为明文；密文非本用户/本机所产则抛 <see cref="CryptographicException"/>。</summary>
    public string Unprotect(byte[] cipher)
    {
        // Unprotect 是 Protect 的逆操作。若当前用户/机器与加密时不一致（或密文损坏、熵不对），
        // 它会抛出 CryptographicException —— 上层正是靠捕获这个异常来识别"疑似换机"。
        byte[] data = ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(data);   // 把解出的字节再按 UTF-8 还原成文本
    }
}
