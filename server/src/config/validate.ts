// 配置校验（PUT /api/config）：逐项校验并返回字段级错误（见 配置说明 §6）。
// 边界取自 @wb/shared/constants 的 WEFLOW_LIMITS，保证前后端一致。
import { WEFLOW_LIMITS } from '@wb/shared/constants'
import type { WeflowConfigUpdate } from '@wb/shared/types'

/** 字段级校验错误：key 为字段路径（如 reconnectIntervalSec） */
export type FieldErrors = Record<string, string>

export interface ValidationResult {
    ok: boolean
    errors: FieldErrors
}

/** 合法主机名 / IPv4 / localhost 的宽松校验 */
function isValidHost(host: string): boolean {
    if (!host) return false
    if (host === 'localhost') return true
    // IPv4
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
    const m = ipv4.exec(host)
    if (m) {
        return m.slice(1).every((seg) => {
            const n = Number(seg)
            return n >= 0 && n <= 255
        })
    }
    // 主机名（含点分段，单段 1-63 字符，字母/数字/连字符）
    const hostname = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
    return hostname.test(host)
}

/** 校验整数且在 [min, max] 闭区间内 */
function checkIntRange(
    errors: FieldErrors,
    key: string,
    value: unknown,
    range: { min: number, max: number },
    label: string,
): void {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors[key] = `${label}必须为整数`
        return
    }
    if (value < range.min || value > range.max) {
        errors[key] = `${label}需在 ${range.min}–${range.max} 之间`
    }
}

/**
 * 校验 WeFlow 配置更新负载（token 全程明文，必填非空）。
 */
export function validateWeflowUpdate(
    update: WeflowConfigUpdate,
): ValidationResult {
    const errors: FieldErrors = {}

    if (typeof update.host !== 'string' || !isValidHost(update.host.trim())) {
        errors.host = '请输入合法的主机地址（IP / 主机名 / localhost）'
    }

    checkIntRange(errors, 'port', update.port, WEFLOW_LIMITS.port, '端口')
    checkIntRange(errors, 'connectTimeoutSec', update.connectTimeoutSec, WEFLOW_LIMITS.connectTimeoutSec, '连接超时')
    checkIntRange(errors, 'readTimeoutSec', update.readTimeoutSec, WEFLOW_LIMITS.readTimeoutSec, '读超时')
    checkIntRange(errors, 'firstMessageTimeoutSec', update.firstMessageTimeoutSec, WEFLOW_LIMITS.firstMessageTimeoutSec, '首消息窗口')
    checkIntRange(errors, 'healthIntervalSec', update.healthIntervalSec, WEFLOW_LIMITS.healthIntervalSec, '探活间隔')
    checkIntRange(errors, 'reconnectIntervalSec', update.reconnectIntervalSec, WEFLOW_LIMITS.reconnectIntervalSec, '重连间隔')
    checkIntRange(errors, 'reconnectLogIntervalSec', update.reconnectLogIntervalSec, WEFLOW_LIMITS.reconnectLogIntervalSec, '重连日志周期')

    // accessToken：必填，trim 后非空
    if (typeof update.accessToken !== 'string' || !update.accessToken.trim()) {
        errors.accessToken = '请输入 Access Token'
    }

    return { ok: Object.keys(errors).length === 0, errors }
}
