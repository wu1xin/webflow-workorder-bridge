using System;          // Guid、Environment 等
using System.IO;        // Path、Directory（路径拼接、目录操作）
using WeflowAgent.Core;  // 被测对象 AppPaths 所在的命名空间

namespace WeflowAgent.Core.Tests;

// ── 关于"单元测试"的背景（新手必读）─────────────────────────────────────────
// 单元测试 = 用代码去验证"另一段代码"的行为是否符合预期。它不是给用户跑的，而是开发时
// 用来"自动体检"的：改了代码后跑一遍测试，全绿就说明没改坏既有行为（这套项目就是 TDD 写的）。
//
// 本项目用的测试框架是 xUnit。框架提供两样东西：
//   ① 特性标注（如 [Fact]）——告诉框架"这个方法是一个测试，请运行它"；
//   ② 断言工具（Assert.XXX）——用来声明"我期望结果是……"，不符就让该测试判定为失败（变红）。
//
// 注意本文件没有写 `using Xunit;`，却能直接用 [Fact]/Assert——因为测试项目配置了"全局 using"，
// 在 obj 下自动生成的 GlobalUsings.g.cs 里有 `global using Xunit;`，相当于所有文件都帮你 using 了。
//
// 一个测试类就是一组相关测试的容器，public 即可，不需要继承什么。
public class AppPathsTests
{
    // [Fact] = "事实"，标注一个"无参数的测试方法"：框架会自动调用它来跑这条测试。
    // 测试方法的命名习惯：用下划线连成一句"做了什么_期望怎样"的描述，读起来像一句话，
    //   失败时报告里直接显示这句话，一眼看懂坏在哪。返回 void（无返回值）。
    [Fact]
    public void Composes_state_file_paths_under_the_given_root()
    {
        // 很多测试遵循 AAA 三段式：Arrange（准备）→ Act（执行）→ Assert（断言）。
        // —— Arrange：准备输入。Path.GetTempPath() 取系统临时目录，拼出一个测试用根目录字符串。
        var root = Path.Combine(Path.GetTempPath(), "weflow-agent-test-root");

        // —— Act：执行被测代码。这里只是 new 一个 AppPaths（构造不碰磁盘，所以无需清理）。
        var paths = new AppPaths(root);

        // —— Assert：逐条核对各属性算出的路径是否等于我们期望的拼接结果。
        // Assert.Equal(期望值, 实际值)：两者相等则通过，不等则该测试失败。
        Assert.Equal(root, paths.RootDirectory);
        Assert.Equal(Path.Combine(root, "config.json"), paths.ConfigFile);
        Assert.Equal(Path.Combine(root, "secrets.dat"), paths.SecretsFile);
        Assert.Equal(Path.Combine(root, "state.db"), paths.StateDbFile);
        Assert.Equal(Path.Combine(root, "logs"), paths.LogsDirectory);
    }

    [Fact]
    public void EnsureCreated_creates_root_and_logs_directories()
    {
        // 这条测试会真的在磁盘上建目录，所以用唯一目录名避免和别的测试/上次运行撞车：
        // Guid.NewGuid() 生成一个全局唯一标识符（几乎不可能重复），.ToString("N") 转成无连字符的字符串。
        var root = Path.Combine(Path.GetTempPath(), "weflow-agent-ensure-" + Guid.NewGuid().ToString("N"));
        // try/finally：finally 块"无论 try 里成功还是抛异常都一定执行"，用来做善后清理，
        //   保证测试结束后把临时目录删掉、不留垃圾。这是涉及真实文件的测试的标准写法。
        try
        {
            var paths = new AppPaths(root);
            // 前置确认：动手前目录还不存在。Assert.False(条件) 断言"条件应为 false"。
            Assert.False(Directory.Exists(root));

            // Act：调用被测方法。
            paths.EnsureCreated();

            // Assert：根目录和 logs 子目录都应被创建出来。Assert.True 断言"条件应为 true"。
            Assert.True(Directory.Exists(root));
            Assert.True(Directory.Exists(paths.LogsDirectory));
        }
        finally
        {
            // 清理：若目录存在就递归删除。recursive: true 是"命名实参"，顺带表明这个 true 的含义
            //   （连同子目录/文件一起删），比单写 true 更易读。
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ForCurrentUser_places_state_under_local_application_data()
    {
        // Act：走工厂方法拿到路径对象。
        var paths = AppPaths.ForCurrentUser("WeflowAgent");

        // Arrange/Assert：用和被测代码"相同的方式"独立算出期望的根目录，再比对。
        var expectedRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WeflowAgent");
        Assert.Equal(expectedRoot, paths.RootDirectory);
    }
}
