using System;                          // Enum、DateTime
using System.Collections.Generic;       // List、Dictionary
using System.ComponentModel;            // CancelEventArgs（窗口关闭事件参数）
using System.Globalization;             // CultureInfo（固定格式化数字/时间）
using System.Linq;                      // Select、Where、ToList
using System.Windows;                   // RoutedEventArgs（按钮点击事件参数）
using System.Windows.Media;             // Color、SolidColorBrush（颜色与画刷）
using WeflowAgent.Core;                 // AgentHealth、StartupStatus、BootstrapResult
using WeflowAgent.Core.Configuration;   // AgentConfig、各枚举、ConfigSaveService、ConfigSaveResult
using WeflowAgent.Core.Security;        // CredentialSet、CredentialLoadStatus
using Wpf.Ui.Controls;                  // FluentWindow（Win11 风格窗口基类）

namespace WeflowAgent.App;

/// <summary>主界面（Fluent）：状态概览 / 配置 / 日志 / 测试 四区。</summary>
public partial class MainWindow : FluentWindow
{
    // 配置编辑所需的引用：当前配置对象（同时作为配置面板的 DataContext）与保存编排服务。
    // 二者由 App.xaml.cs 启动时通过 InitializeConfigEditor 注入；未注入前为 null（保存按钮会忽略点击）。
    private AgentConfig? _config;
    private ConfigSaveService? _saveService;

    // 字段路径前缀 → (内层分组 Tab 序号, 中文分组名)。用于把校验错误定位、跳转到对应分组。
    private static readonly Dictionary<string, (int Index, string Label)> GroupMap = new()
    {
        ["WeFlow"] = (0, "WeFlow"),
        ["Downstream"] = (1, "下游"),
        ["Media"] = (2, "媒体"),
        ["Catchup"] = (3, "补偿"),
        ["Dedup"] = (4, "去重"),
        ["Filter"] = (5, "过滤"),
        ["Heartbeat"] = (6, "心跳"),
        ["Runtime"] = (7, "运行"),
        ["Sync"] = (8, "同步"),
        ["Install"] = (9, "安装"),
        ["Logging"] = (10, "日志"),
        ["Advanced"] = (11, "高级"),
    };

    public MainWindow()
    {
        InitializeComponent();
    }

    /// <summary>把启动态结果填入状态概览区。</summary>
    public void ApplyStatus(BootstrapResult result)
    {
        ApplyHealth(result.Status);
        StateDirText.Text = result.Paths.RootDirectory;
        SchemaText.Text = result.SchemaVersion.ToString(CultureInfo.InvariantCulture);
    }

    // 把"健康度 + 摘要"映射成托盘色块与文案。抽出来供 ApplyStatus 与保存成功后复用。
    private void ApplyHealth(StartupStatus status)
    {
        (Color color, string label) = status.Health switch
        {
            AgentHealth.Green => (Color.FromRgb(0x3F, 0xB9, 0x50), "● 就绪"),
            AgentHealth.Yellow => (Color.FromRgb(0xE8, 0xB1, 0x1E), "● 需配置"),
            _ => (Color.FromRgb(0xE3, 0x4A, 0x3A), "● 异常"),
        };
        HealthPill.Background = new SolidColorBrush(color);
        HealthText.Text = label;
        SummaryText.Text = status.Summary;
    }

    /// <summary>
    /// 装载配置编辑器：把配置对象设为面板 DataContext，填充枚举下拉、列表/标志位/可空等"非绑定"字段，
    /// 以及（若已存在）回填三处掩码凭据。由 App 启动时调用一次。
    /// </summary>
    public void InitializeConfigEditor(AgentConfig config, CredentialSet? existingCredentials, ConfigSaveService saveService)
    {
        _config = config;
        _saveService = saveService;

        // 先给枚举下拉灌入候选项，再设 DataContext——保证设 DataContext 时 SelectedItem 绑定值能在候选项中命中。
        DetectModeBox.ItemsSource = Enum.GetValues(typeof(MediaDetectMode));
        FetchModeBox.ItemsSource = Enum.GetValues(typeof(MediaFetchMode));
        OversizePolicyBox.ItemsSource = Enum.GetValues(typeof(OversizePolicy));
        InitialStrategyBox.ItemsSource = Enum.GetValues(typeof(InitialSyncStrategy));
        UninstallPolicyBox.ItemsSource = Enum.GetValues(typeof(UninstallStatePolicy));
        LogLevelBox.ItemsSource = Enum.GetValues(typeof(LogLevel));

        ConfigPanels.DataContext = config;

        // 列表型字段（每行一个）。
        PlaceholdersBox.Text = string.Join(Environment.NewLine, config.Media.Placeholders);
        AllowListBox.Text = string.Join(Environment.NewLine, config.Filter.SessionAllowList);
        BlockListBox.Text = string.Join(Environment.NewLine, config.Filter.SessionBlockList);

        // [Flags] 触发时机 → 三个勾选框。
        TrigReconnect.IsChecked = config.Catchup.Triggers.HasFlag(CatchupTriggers.Reconnect);
        TrigStartup.IsChecked = config.Catchup.Triggers.HasFlag(CatchupTriggers.Startup);
        TrigScheduled.IsChecked = config.Catchup.Triggers.HasFlag(CatchupTriggers.Scheduled);

        // 可空数值 / 时间（空字符串表示"未设"）。
        TotalSizeCapBox.Text = config.Media.TotalSizeCapMb?.ToString(CultureInfo.InvariantCulture) ?? string.Empty;
        InitialLookbackBox.Text = config.Sync.InitialLookbackHours?.ToString(CultureInfo.InvariantCulture) ?? string.Empty;
        SpecifiedStartBox.Text = config.Sync.SpecifiedStartTime?.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) ?? string.Empty;

        // 凭据回填（同机同用户、DPAPI 已解密）；PasswordBox 不支持绑定，故 code-behind 赋值。
        if (existingCredentials is not null)
        {
            WeflowTokenBox.Password = existingCredentials.WeflowAccessToken ?? string.Empty;
            SiteKeyBox.Password = existingCredentials.DownstreamSiteKey ?? string.Empty;
            AesKeyBox.Password = existingCredentials.DownstreamAesKey ?? string.Empty;
        }
    }

    // ── 保存按钮 ──────────────────────────────────────────────────────────
    private void OnSaveClick(object sender, RoutedEventArgs e)
    {
        if (_config is null || _saveService is null)
            return;

        // 普通 string/int/bool 字段已由 TwoWay 绑定写回 _config；这里补收集"非绑定"的特殊字段。
        _config.Media.Placeholders = ParseLines(PlaceholdersBox.Text);
        _config.Filter.SessionAllowList = ParseLines(AllowListBox.Text);
        _config.Filter.SessionBlockList = ParseLines(BlockListBox.Text);
        _config.Catchup.Triggers = CollectTriggers();
        _config.Media.TotalSizeCapMb = ParseNullableInt(TotalSizeCapBox.Text);
        _config.Sync.InitialLookbackHours = ParseNullableInt(InitialLookbackBox.Text);
        _config.Sync.SpecifiedStartTime = ParseNullableDateTime(SpecifiedStartBox.Text);

        var credentials = new CredentialSet
        {
            WeflowAccessToken = NullIfBlank(WeflowTokenBox.Password),
            DownstreamSiteKey = NullIfBlank(SiteKeyBox.Password),
            DownstreamAesKey = NullIfBlank(AesKeyBox.Password),
        };

        ConfigSaveResult result = _saveService.Save(_config, credentials);

        if (result.Saved)
        {
            SaveHintText.Foreground = new SolidColorBrush(Color.FromRgb(0x3F, 0xB9, 0x50));
            SaveHintText.Text = "✔ 配置已保存。";
            // 凭据已齐备并成功落盘 → 状态转绿。
            ApplyHealth(StartupStatus.FromCredentials(CredentialLoadStatus.Loaded));
        }
        else
        {
            SaveHintText.Foreground = new SolidColorBrush(Color.FromRgb(0xE3, 0x4A, 0x3A));
            IEnumerable<string> lines = result.Validation.Errors
                .Select(err => $"• [{GroupLabel(err.Field)}] {err.Message}");
            SaveHintText.Text = "✘ 校验未通过：" + Environment.NewLine + string.Join(Environment.NewLine, lines);
            // 跳到第一条错误所在分组，方便用户立刻定位。
            int index = GroupIndex(result.Validation.Errors[0].Field);
            if (index >= 0)
                GroupList.SelectedIndex = index;
        }
    }

    // ── 收集/解析辅助 ────────────────────────────────────────────────────
    // 多行文本 → 去空白、去空行后的字符串列表。
    private static List<string> ParseLines(string text) =>
        text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(s => s.Trim())
            .Where(s => s.Length > 0)
            .ToList();

    // 三个勾选框 → [Flags] 组合。
    private CatchupTriggers CollectTriggers()
    {
        var triggers = CatchupTriggers.None;
        if (TrigReconnect.IsChecked == true) triggers |= CatchupTriggers.Reconnect;
        if (TrigStartup.IsChecked == true) triggers |= CatchupTriggers.Startup;
        if (TrigScheduled.IsChecked == true) triggers |= CatchupTriggers.Scheduled;
        return triggers;
    }

    // 空/非数字 → null；否则解析为整数。
    private static int? ParseNullableInt(string text) =>
        int.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) ? v : null;

    // 空/非法时间 → null；否则解析为 DateTime。
    private static DateTime? ParseNullableDateTime(string text) =>
        DateTime.TryParse(text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime dt) ? dt : null;

    // 空白 → null（让校验把"必填缺失"判出来），否则原值。
    private static string? NullIfBlank(string value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    // 字段路径（如 "Downstream.BaseUrl"）的分组前缀 → 中文标签 / Tab 序号。
    private static string GroupLabel(string field) =>
        GroupMap.TryGetValue(Prefix(field), out var g) ? g.Label : Prefix(field);

    private static int GroupIndex(string field) =>
        GroupMap.TryGetValue(Prefix(field), out var g) ? g.Index : -1;

    private static string Prefix(string field)
    {
        int dot = field.IndexOf('.');
        return dot > 0 ? field.Substring(0, dot) : field;
    }

    // ── 重写窗口关闭事件：默认最小化到托盘（FR-UI-04）──
    protected override void OnClosing(CancelEventArgs e)
    {
        e.Cancel = true;
        Hide();
        base.OnClosing(e);
    }
}
