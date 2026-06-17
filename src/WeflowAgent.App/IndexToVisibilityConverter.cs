using System;                       // Type、NotSupportedException
using System.Globalization;          // CultureInfo、NumberStyles
using System.Windows;                // Visibility
using System.Windows.Data;           // IValueConverter

namespace WeflowAgent.App;

/// <summary>
/// 把"当前选中索引"（绑定值）与目标索引（ConverterParameter）比较：相等→Visible，否则→Collapsed。
/// 用于配置区"左侧 ListBox 选哪项、右侧就显示哪个面板"的切换。
/// </summary>
public sealed class IndexToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object? parameter, CultureInfo culture)
    {
        int selected = value is int i ? i : -1;
        int target = int.TryParse(parameter?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int p) ? p : -2;
        return selected == target ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
