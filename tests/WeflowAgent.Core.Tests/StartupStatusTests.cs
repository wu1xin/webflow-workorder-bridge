using WeflowAgent.Core;            // AgentHealth、StartupStatus
using WeflowAgent.Core.Security;    // CredentialLoadStatus

namespace WeflowAgent.Core.Tests;

public class StartupStatusTests
{
    // ── 数据驱动测试：[Theory] + [InlineData] ─────────────────────────────
    // 前面的 [Fact] 是"无参数、固定一种情况"的测试。当同一套逻辑要用"多组不同输入/期望"反复验证时，
    // 改用 [Theory]（理论）：它表示"这个带参数的方法是一个测试模板"。
    // 每个 [InlineData(...)] 提供一组实参，框架会用每组数据各跑一次本方法——所以下面这一个方法
    // 实际会被当成 3 条独立测试来运行（对应三种凭据状态 → 三种健康度）。
    // 括号里的值按顺序对应方法参数：第 1 个 → input，第 2 个 → expected。
    [Theory]
    [InlineData(CredentialLoadStatus.Loaded, AgentHealth.Green)]
    [InlineData(CredentialLoadStatus.Missing, AgentHealth.Yellow)]
    [InlineData(CredentialLoadStatus.Undecryptable, AgentHealth.Red)]
    public void Maps_credential_status_to_tray_health(CredentialLoadStatus input, AgentHealth expected)
    {
        // Act：把"凭据状态"映射成"启动态"。
        StartupStatus status = StartupStatus.FromCredentials(input);

        // Assert 1：映射出的健康度应等于这组数据期望的颜色。
        Assert.Equal(expected, status.Health);
        // Assert 2：摘要文案不能是空或纯空白。
        //   string.IsNullOrWhiteSpace(s) 在 s 为 null、空串、或只含空格时返回 true；
        //   我们期望"有真正的文案"，所以断言它为 false。
        Assert.False(string.IsNullOrWhiteSpace(status.Summary));
    }
}
