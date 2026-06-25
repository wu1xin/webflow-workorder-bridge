// 配置 store：加载/保存 config.json（内部工具，accessToken 全程明文，不加密、不掩码）。
// 见 docs/config/weflow-配置说明.md §5（数据结构）、§6（校验）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppConfig, DownstreamConfig, WeflowConfig, WeflowConfigUpdate } from '@wb/shared/types'
import { configFilePath } from './paths.js'
import { validateWeflowUpdate, type FieldErrors } from './validate.js'

/** 校验失败异常：携带字段级错误，路由层转成 400 */
export class ConfigValidationError extends Error {
    constructor(public readonly fields: FieldErrors) {
        super('配置校验失败')
        this.name = 'ConfigValidationError'
    }
}

/**
 * 从落盘 JSON 还原内存态配置（明文，无默认值）。
 * 「有就是有，没就是没」：文件里有 weflow 就原样采用，没有即未配置（undefined）。
 */
function decodeFromDisk(raw: unknown): AppConfig {
    const r = raw as { weflow?: WeflowConfig, downstream?: DownstreamConfig } | null
    return { weflow: r?.weflow, downstream: r?.downstream }
}

/**
 * 配置 store。进程内单例，持有内存态配置（全程明文）。
 * - 路由与连接管理器统一用 {@link get} / {@link getWeflow}。
 */
export class ConfigStore {
    private config: AppConfig

    private constructor(config: AppConfig) {
        this.config = config
    }

    /** 从磁盘加载（缺文件即「未配置」态，weflow 为 undefined） */
    static load(): ConfigStore {
        const file = configFilePath()
        const _store = new ConfigStore({ weflow: undefined })
        if (existsSync(file)) {
            const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
            return new ConfigStore(decodeFromDisk(raw))
        }
        return _store
    }

    /** 当前内存态配置（含明文 Token），供连接管理器使用 */
    get(): AppConfig {
        return this.config
    }

    /** 当前 WeFlow 配置（含明文 Token）；未配置时为 undefined，不伪造默认值 */
    getWeflow(): WeflowConfig | undefined {
        return this.config.weflow
    }

    /** 当前下游接入配置；未配置为 undefined */
    getDownstream(): DownstreamConfig | undefined {
        return this.config.downstream
    }

    /** 是否已配置可用 Token */
    hasToken(): boolean {
        return Boolean(this.config.weflow?.accessToken)
    }

    /** 是否已具备建链所需的最小配置（host/port/token 齐全） */
    isConnectable(): boolean {
        const w = this.config.weflow
        return Boolean(w?.host) && Boolean(w?.port) && Boolean(w?.accessToken)
    }

    /**
     * 校验并保存 WeFlow 配置更新（token 直接整体写回，无掩码/保持不变逻辑）。
     * - 校验失败抛 {@link ConfigValidationError}。
     * 返回更新后的内存态配置。
     */
    saveWeflow(update: WeflowConfigUpdate): AppConfig {
        const result = validateWeflowUpdate(update)
        if (!result.ok) {
            throw new ConfigValidationError(result.errors)
        }

        const next: AppConfig = {
            weflow: {
                host: update.host.trim(),
                port: update.port,
                accessToken: update.accessToken.trim(),
                connectTimeoutSec: update.connectTimeoutSec,
                readTimeoutSec: update.readTimeoutSec,
                firstMessageTimeoutSec: update.firstMessageTimeoutSec,
                reconnectIntervalSec: update.reconnectIntervalSec,
                reconnectLogIntervalSec: update.reconnectLogIntervalSec,
            },
            downstream: this.config.downstream,
        }

        this.persist(next)
        this.config = next
        return next
    }

    /** 明文落盘（有就写，没有就是没有，不补默认值） */
    private persist(cfg: AppConfig): void {
        const file = configFilePath()
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ weflow: cfg.weflow, downstream: cfg.downstream }, null, 2), 'utf8')
    }
}
