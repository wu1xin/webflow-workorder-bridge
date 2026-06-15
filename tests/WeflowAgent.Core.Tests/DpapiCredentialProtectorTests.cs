using System.Text;                  // （编码相关；本文件实际未直接用到，属隐式保留）
using WeflowAgent.Core.Security;     // 被测对象 DpapiCredentialProtector

namespace WeflowAgent.Core.Tests;

public class DpapiCredentialProtectorTests
{
    // "往返测试"（roundtrip）：把数据"加密再解密"，验证绕一圈后能原样还原。
    // 这是验证"一对互逆操作"（加密/解密、序列化/反序列化…）最常用、最有效的套路。
    [Fact]
    public void Roundtrips_plaintext_through_protect_and_unprotect()
    {
        // Arrange：准备加解密器和一段明文。const 表示编译期常量、不可改（见 Core 里的说明）。
        var protector = new DpapiCredentialProtector();
        const string secret = "weflow-access-token-123";

        // Act：先加密成密文字节，再把密文解密回字符串。
        byte[] cipher = protector.Protect(secret);
        string recovered = protector.Unprotect(cipher);

        // Assert：解出来的应当和原始明文完全一致。
        // （注意：这条测试依赖运行它的 Windows 用户与机器一致——因为 DPAPI 把密钥绑定到当前用户，
        //   这正是被测类的设计前提。）
        Assert.Equal(secret, recovered);
    }
}
