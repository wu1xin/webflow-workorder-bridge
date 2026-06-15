using System;                       // InvalidOperationException
using System.Collections.Generic;    // List<T>
using WeflowAgent.Core.Persistence;  // 被测对象 SchemaMigrator、接口 ISchemaMigration

namespace WeflowAgent.Core.Tests;

public class SchemaMigratorTests
{
    // ── 测试替身（test double）─────────────────────────────────────────────
    // 要测 SchemaMigrator，就得喂给它一些"迁移步骤"。但真实迁移会改数据库、有副作用，不适合测试。
    // 于是我们在测试里"自己造假的迁移步骤"——只要实现 ISchemaMigration 接口即可（回顾接口=能力契约）。
    // 这种为测试而造的轻量假实现就叫"测试替身"。它们是嵌套在测试类里的 private 类（仅本测试用）。
    //
    // RecordingMigration：一个"会记账的"假迁移。它的 Apply() 不干实事，只把自己的版本号记进一个
    //   共享列表，方便测试事后检查"哪些迁移被调用了、按什么顺序"（这种替身也叫 spy/间谍）。
    private sealed class RecordingMigration : ISchemaMigration
    {
        private readonly List<int> _log;   // 外部传入的共享日志列表（List<int> = 元素为 int 的可变列表）
        public RecordingMigration(int fromVersion, List<int> log)
        {
            FromVersion = fromVersion;     // 实现接口要求的属性
            _log = log;
        }
        public int FromVersion { get; }
        // 实现接口要求的方法：被调用时就把自己的版本号追加进日志。表达式体写法。
        public void Apply() => _log.Add(FromVersion);
    }

    // ThrowingMigration：一个"一调用就抛异常的"假迁移，用来模拟"迁移中途失败"的场景。
    private sealed class ThrowingMigration : ISchemaMigration
    {
        // 构造函数也用表达式体：只有一句赋值时可以这么简写。
        public ThrowingMigration(int fromVersion) => FromVersion = fromVersion;
        public int FromVersion { get; }
        // throw 在表达式里也能用：一进 Apply 就抛 InvalidOperationException（消息 "boom"）。
        public void Apply() => throw new InvalidOperationException("boom");
    }

    [Fact]
    public void Migrate_runs_no_migrations_when_already_at_current_version()
    {
        var log = new List<int>();
        // currentVersion: 3 是"命名实参"（顺带标注这个 3 是当前版本），可读性更好。
        // 第二个参数传一个 ISchemaMigration 数组（里面放两个记账替身）。
        var migrator = new SchemaMigrator(currentVersion: 3, new ISchemaMigration[]
        {
            new RecordingMigration(1, log),
            new RecordingMigration(2, log),
        });

        // Act：存量版本已等于当前版本(3)，应当一步都不迁移。
        int result = migrator.Migrate(storedVersion: 3);

        Assert.Equal(3, result);
        Assert.Empty(log);     // 断言"集合为空"：没有任何迁移被调用过（日志没记到东西）。
    }

    [Fact]
    public void Migrate_applies_migrations_in_order_up_to_current()
    {
        var log = new List<int>();
        var migrator = new SchemaMigrator(currentVersion: 3, new ISchemaMigration[]
        {
            new RecordingMigration(2, log), // 故意乱序，验证内部按 FromVersion 排序
            new RecordingMigration(1, log),
        });

        // Act：从版本 1 迁到当前 3，应当依次执行 1->2、2->3。
        int result = migrator.Migrate(storedVersion: 1);

        Assert.Equal(3, result);
        // 断言日志内容正好是 [1, 2]：即便上面传入时是乱序，迁移器也应按版本升序执行。
        // new[] { 1, 2 } 是数组字面量；Assert.Equal 对集合会逐元素比较（顺序也要一致）。
        Assert.Equal(new[] { 1, 2 }, log); // 先 1->2 再 2->3
    }

    [Fact]
    public void Migrate_stops_and_wraps_failure_in_SchemaMigrationException()
    {
        var log = new List<int>();
        var migrator = new SchemaMigrator(currentVersion: 3, new ISchemaMigration[]
        {
            new RecordingMigration(1, log),
            new ThrowingMigration(2),       // 第二步会抛异常
        });

        // Assert.Throws<T>(() => 动作)：断言"执行这个动作时应当抛出 T 类型的异常"。
        //   若没抛、或抛了别的类型，测试就失败；若抛对了，它会把异常对象返回，供后续进一步检查。
        //   括号里的 `() => migrator.Migrate(...)` 是 lambda：把"要执行的动作"包成一个方法传进去，
        //   这样 Assert.Throws 才能在内部用 try/catch 包住它来捕获异常。
        var ex = Assert.Throws<SchemaMigrationException>(() => migrator.Migrate(storedVersion: 1));

        // 进一步核对异常细节：失败发生在 2->3 这一步，故 FailedFromVersion 应为 2。
        Assert.Equal(2, ex.FailedFromVersion);
        // 且只有 1->2 成功执行过；2->3 失败后立即停止，不再继续。
        Assert.Equal(new[] { 1 }, log); // 仅 1->2 应用，2->3 失败后停止
    }
}
