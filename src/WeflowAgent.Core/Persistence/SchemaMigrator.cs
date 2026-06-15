using System;                       // Exception（异常基类）
using System.Collections.Generic;    // IReadOnlyList<T>、IEnumerable<T>（集合接口）
using System.Linq;                   // LINQ 扩展方法：OrderBy、First…（对集合做查询/排序）

namespace WeflowAgent.Core.Persistence;

/// <summary>
/// 模式迁移失败异常。携带失败的起始版本号，供上层告警；
/// 数据停留在最后成功应用的版本，不静默覆盖（SRS FR-SYNC-09）。
/// </summary>
//
// 自定义异常：继承内置的 `Exception`。当某种特定错误发生时，抛出一个"专属类型"的异常，
// 比抛通用 Exception 更利于上层"精确捕获并区别处理"。
public sealed class SchemaMigrationException : Exception
{
    // 构造函数。`: base(...)` 表示"先调用父类 Exception 的构造函数"，把一段错误消息传给它。
    //   $"...{failedFromVersion}..." 是字符串插值，把版本号嵌进消息文本。
    public SchemaMigrationException(int failedFromVersion, Exception innerException)
        : base($"模式迁移失败：v{failedFromVersion} -> v{failedFromVersion + 1}。", innerException)
    {
        // innerException（内层异常）通过 base 传给父类保存：记录"到底是什么底层错误引发了迁移失败"，
        // 便于排查时看到完整的异常链。
        FailedFromVersion = failedFromVersion;   // 额外把失败版本号存到自定义属性，供上层读取
    }

    /// <summary>迁移失败的起始版本（即 <c>FailedFromVersion -> FailedFromVersion+1</c> 这一步失败）。</summary>
    public int FailedFromVersion { get; }
}

/// <summary>一次模式迁移：把数据从 <see cref="FromVersion"/> 升到 <c>FromVersion + 1</c>。</summary>
//
// `interface`（接口）= 一份"能力契约"：只规定有哪些成员（属性/方法），不写具体实现。
// 任何"实现了 ISchemaMigration 的类"都必须提供 FromVersion 和 Apply()。
// 好处：迁移器只依赖这个抽象契约，将来加多少个具体迁移步骤都能统一处理（多态）。
// 约定俗成：接口名以大写 I 开头。
public interface ISchemaMigration
{
    int FromVersion { get; }   // 这一步迁移"从哪个版本开始"
    void Apply();              // 执行迁移动作（具体怎么改数据，由实现类去写）
}

/// <summary>
/// 本地存储的模式版本迁移器：启动时把旧版本数据平滑升到当前版本（SRS FR-SYNC-09）。
/// </summary>
public sealed class SchemaMigrator
{
    private readonly int _currentVersion;
    // IReadOnlyList<T> = "只读列表"接口；<ISchemaMigration> 是泛型参数，表示列表里装的是迁移步骤。
    // 用"只读"类型表明：这个列表一旦建好，本类内部也不会再增删它。
    private readonly IReadOnlyList<ISchemaMigration> _migrations;

    // 构造函数：接收当前目标版本，以及一批迁移步骤。
    // 参数类型 IEnumerable<T> 是"可被逐个遍历的序列"——最宽松的集合接口，数组/List 都能传进来。
    public SchemaMigrator(int currentVersion, IEnumerable<ISchemaMigration> migrations)
    {
        _currentVersion = currentVersion;
        // 下面这串是 LINQ（语言集成查询），用链式方法对集合做处理：
        //   .OrderBy(m => m.FromVersion)  按每个迁移步骤的 FromVersion 升序排序；
        //                                 (m => m.FromVersion) 是 lambda，表示"取每个元素 m 的 FromVersion 当排序键"。
        //   .ToList()                     把排序结果固化成一个 List 存起来。
        // 排序是为了后面能"从低版本到高版本逐级"地应用迁移。
        _migrations = migrations.OrderBy(m => m.FromVersion).ToList();
    }

    /// <summary>把 <paramref name="storedVersion"/> 的数据迁移到当前版本，返回迁移后的版本。</summary>
    //  注：<paramref name="..."/> 是文档注释里"引用某个参数名"的标签。
    public int Migrate(int storedVersion)
    {
        // 已经是最新版本，无需迁移，直接返回。
        if (storedVersion == _currentVersion)
            return _currentVersion;

        // for 循环：从已存版本一路升到当前版本，每次升一级（v -> v+1）。
        //   语法 for (初始化; 继续条件; 每轮自增) { 循环体 }。这里 v 从 storedVersion 开始，
        //   只要 v < 当前版本就继续，每轮结束 v++（v 加 1）。
        for (int v = storedVersion; v < _currentVersion; v++)
        {
            // 从迁移列表里找出"FromVersion 正好等于 v"的那一步。
            //   .First(条件) 返回第一个满足条件的元素；若一个都没有会抛异常
            //   （这里隐含约定：每个相邻版本都必须有对应迁移步骤，否则就是配置漏了）。
            ISchemaMigration migration = _migrations.First(m => m.FromVersion == v);
            try
            {
                migration.Apply();   // 执行这一级迁移
            }
            catch (Exception ex)     // 捕获任意异常（ex 是捕获到的异常对象）
            {
                // 停在最后成功版本，包装抛出供告警；不继续、不静默覆盖。
                // 把原始异常 ex 作为 innerException 包进我们的自定义异常，再 throw 抛给上层。
                // 这样：① 上层能识别这是"迁移失败"；② 仍保留原始错误细节；③ 循环就此中断，
                //       数据不会被后续步骤继续改动。
                throw new SchemaMigrationException(v, ex);
            }
        }

        return _currentVersion;   // 全部升级成功，返回当前版本
    }
}
