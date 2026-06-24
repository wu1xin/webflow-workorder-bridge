// 本地落盘路径解析。配置统一放在 %LOCALAPPDATA%\weflow-bridge\
// （见 docs/config/weflow-配置说明.md「落盘位置」）。非 Windows 平台回退到用户目录下的隐藏目录。
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 应用数据目录：Windows 取 LOCALAPPDATA，其余平台回退 ~/.weflow-bridge */
export function appDataDir(): string {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share')
    return join(base, 'weflow-bridge')
}

/** 配置文件路径（明文落盘） */
export function configFilePath(): string {
    return join(appDataDir(), 'config.json')
}
