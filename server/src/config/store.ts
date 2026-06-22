// 配置 store：加载/保存 config.json，对 accessToken 透明加解密，内存态持有明文。
// 见 docs/config/weflow-配置说明.md §5（数据结构）、§6（校验）、§7（加密）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_WEFLOW_CONFIG } from '@wb/shared/constants'
import type { AppConfig, WeflowConfig, WeflowConfigUpdate } from '@wb/shared/types'
import { configFilePath } from './paths.js'
import { decrypt, encrypt, ensureAppDataDir, isEncryptedEnvelope } from './crypto.js'
import { maskAppConfig } from './mask.js'
import { validateWeflowUpdate, type FieldErrors } from './validate.js'

/** 校验失败异常：携带字段级错误，路由层转成 400 */
export class ConfigValidationError extends Error {
    constructor(public readonly fields: FieldErrors) {
        super('配置校验失败')
        this.name = 'ConfigValidationError'
    }
}

/** 合并默认值，容忍落盘配置缺字段（向前兼容） */
function withWeflowDefaults(partial: Partial<WeflowConfig> | undefined): WeflowConfig {
    const d = DEFAULT_WEFLOW_CONFIG
    const p = partial ?? {}
    return {
        host: typeof p.host === 'string' ? p.host : d.host,
        port: typeof p.port === 'number' ? p.port : d.port,
        accessToken: typeof p.accessToken === 'string' ? p.accessToken : d.accessToken,
        connectTimeoutSec: typeof p.connectTimeoutSec === 'number' ? p.connectTimeoutSec : d.connectTimeoutSec,
        readTimeoutSec: typeof p.readTimeoutSec === 'number' ? p.readTimeoutSec : d.readTimeoutSec,
        firstMessageTimeoutSec: typeof p.firstMessageTimeoutSec === 'number' ? p.firstMessageTimeoutSec : d.firstMessageTimeoutSec,
        healthIntervalSec: typeof p.healthIntervalSec === 'number' ? p.healthIntervalSec : d.healthIntervalSec,
        reconnectIntervalSec: typeof p.reconnectIntervalSec === 'number' ? p.reconnectIntervalSec : d.reconnectIntervalSec,
        reconnectLogIntervalSec: typeof p.reconnectLogIntervalSec === 'number' ? p.reconnectLogIntervalSec : d.reconnectLogIntervalSec,
    }
}

/** 从落盘 JSON 还原内存态配置：解密 accessToken 信封 */
function decodeFromDisk(raw: unknown): AppConfig {
    const weflowRaw = (raw as { weflow?: Record<string, unknown> } | null)?.weflow ?? {}
    const tokenField = weflowRaw.accessToken
    let token = ''
    if (typeof tokenField === 'string') {
        token = tokenField
    } else if (isEncryptedEnvelope(tokenField)) {
        token = decrypt(tokenField)
    }
    const weflow = withWeflowDefaults({ ...weflowRaw, accessToken: token } as Partial<WeflowConfig>)
    return { weflow }
}

/** 序列化为落盘 JSON：accessToken 替换为加密信封（非空时）。 */
function encodeForDisk(cfg: AppConfig): unknown {
    const { accessToken, ...rest } = cfg.weflow
    return {
        weflow: {
            ...rest,
            accessToken: accessToken ? encrypt(accessToken) : '',
        },
    }
}

/**
 * 配置 store。进程内单例，持有明文内存态配置。
 * - 路由读配置用 {@link getMasked}（掩码）。
 * - 连接管理器用 {@link get}（明文）。
 */
export class ConfigStore {
    private config: AppConfig

    private constructor(config: AppConfig) {
        this.config = config
    }

    /** 从磁盘加载（缺文件则用默认值、空 Token，即「未配置」态） */
    static load(): ConfigStore {
        const file = configFilePath()
        if (!existsSync(file)) {
            return new ConfigStore({ weflow: withWeflowDefaults(undefined) })
        }
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
        return new ConfigStore(decodeFromDisk(raw))
    }

    /** 当前内存态配置（含明文 Token），供连接管理器使用 */
    get(): AppConfig {
        return this.config
    }

    /** 掩码后的配置，供 GET /api/config 返回 */
    getMasked(): AppConfig {
        return maskAppConfig(this.config)
    }

    /** 是否已配置可用 Token */
    hasToken(): boolean {
        return Boolean(this.config.weflow.accessToken)
    }

    /** 是否已具备建链所需的最小配置（host/port/token 齐全） */
    isConnectable(): boolean {
        const w = this.config.weflow
        return Boolean(w.host) && Boolean(w.port) && Boolean(w.accessToken)
    }

    /**
     * 校验并保存 WeFlow 配置更新。
     * - accessToken 为 null/undefined → 保持原值（不被掩码串覆盖，见 §6 掩码字段保存陷阱）。
     * - 校验失败抛 {@link ConfigValidationError}。
     * 返回更新后的内存态配置（含明文）。
     */
    saveWeflow(update: WeflowConfigUpdate): AppConfig {
        const result = validateWeflowUpdate(update, { hasExistingToken: this.hasToken() })
        if (!result.ok) {
            throw new ConfigValidationError(result.errors)
        }

        const token = update.accessToken
        const nextToken = token === null || token === undefined
            ? this.config.weflow.accessToken
            : token.trim()

        const next: AppConfig = {
            weflow: {
                host: update.host.trim(),
                port: update.port,
                accessToken: nextToken,
                connectTimeoutSec: update.connectTimeoutSec,
                readTimeoutSec: update.readTimeoutSec,
                firstMessageTimeoutSec: update.firstMessageTimeoutSec,
                healthIntervalSec: update.healthIntervalSec,
                reconnectIntervalSec: update.reconnectIntervalSec,
                reconnectLogIntervalSec: update.reconnectLogIntervalSec,
            },
        }

        this.persist(next)
        this.config = next
        return next
    }

    /** 加密落盘 */
    private persist(cfg: AppConfig): void {
        ensureAppDataDir()
        const file = configFilePath()
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(encodeForDisk(cfg), null, 2), 'utf8')
    }
}
