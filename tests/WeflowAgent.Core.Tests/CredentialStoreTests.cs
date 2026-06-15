using System;                       // Guid
using System.IO;                     // Path、File
using WeflowAgent.Core.Security;     // 被测对象 CredentialStore 及相关类型

namespace WeflowAgent.Core.Tests;

public class CredentialStoreTests
{
    // 私有静态辅助方法：每次调用都生成一个"唯一的临时 secrets 文件路径"，供各测试独立使用，
    // 互不干扰。表达式体写法 `=> ...`（见 Core 里的说明）。用 Guid 保证文件名唯一。
    private static string TempSecretsPath() =>
        Path.Combine(Path.GetTempPath(), "weflow-secrets-" + Guid.NewGuid().ToString("N") + ".dat");

    [Fact]
    public void Load_reports_missing_when_secrets_file_absent()
    {
        // Arrange：构造一个指向"尚不存在的文件"的 store（没创建文件，所以无需清理）。
        var path = TempSecretsPath();
        var store = new CredentialStore(path, new DpapiCredentialProtector());

        // Act：尝试加载。
        CredentialLoadResult result = store.Load();

        // Assert：文件不存在时应报告 Missing（而不是报错崩溃）。
        Assert.Equal(CredentialLoadStatus.Missing, result.Status);
    }

    [Fact]
    public void Save_then_Load_roundtrips_the_credentials()
    {
        var path = TempSecretsPath();
        try     // 又是 try/finally：这条会真的写文件，结束后在 finally 里删掉。
        {
            var store = new CredentialStore(path, new DpapiCredentialProtector());
            // 准备一组凭据（对象初始化器写法）。
            var original = new CredentialSet
            {
                WeflowAccessToken = "tok-abc",
                DownstreamAesKey = "0123456789abcdef",
                DownstreamSiteKey = "weflow-agent-site",
            };

            // Act：存盘，再读回来——又一个"往返测试"。
            store.Save(original);
            CredentialLoadResult result = store.Load();

            // Assert：状态应为 Loaded，且各字段原样还原。
            Assert.Equal(CredentialLoadStatus.Loaded, result.Status);
            Assert.NotNull(result.Credentials);     // 断言"非空"：Loaded 时必须带回凭据对象
            // result.Credentials! 末尾的 `!` 是"空值抑制运算符"：上一行已断言它非空，
            //   这里用 ! 告诉编译器"我确定它不是 null，别再警告我"。后续访问 . 就不再被判可空。
            Assert.Equal("tok-abc", result.Credentials!.WeflowAccessToken);
            Assert.Equal("0123456789abcdef", result.Credentials.DownstreamAesKey);
            Assert.Equal("weflow-agent-site", result.Credentials.DownstreamSiteKey);
        }
        finally
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }

    [Fact]
    public void Load_reports_undecryptable_when_secrets_cannot_be_decrypted()
    {
        var path = TempSecretsPath();
        try
        {
            // 模拟"换机/换用户"：文件在、但内容并非本用户 DPAPI 所产 → 解密会失败。
            // 直接写入一串随机字节冒充"别处来的密文"，解密时必抛 CryptographicException。
            // new byte[] { ... } 是"数组字面量"：直接列出元素来初始化一个字节数组。
            File.WriteAllBytes(path, new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 });
            var store = new CredentialStore(path, new DpapiCredentialProtector());

            // Act：加载（内部会捕获解密异常并转成状态码，而非让异常冒出来）。
            CredentialLoadResult result = store.Load();

            // Assert：应识别为 Undecryptable（疑似换机），且不带回任何凭据。
            Assert.Equal(CredentialLoadStatus.Undecryptable, result.Status);
            Assert.Null(result.Credentials);   // 断言"为空"
        }
        finally
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }
}
