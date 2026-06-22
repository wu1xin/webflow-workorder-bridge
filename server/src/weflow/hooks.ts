// 连接生命周期对外的两个挂钩：聊天记录同步、告警。
// 二者的具体实现分属其它模块（core/compensation、告警通道，见需求文档 §8、§6 两个关键区分），
// 本连接层只在「连上成功」「掉线/重连失败」时调用挂钩。此处提供仅记日志的桩实现。
import type { Logger } from './logger.js'

/** 连接成功后的同步动作来源：初次连接=全量同步；重连恢复=补偿同步（链路文档 §6） */
export type SyncReason = 'initial' | 'recovery'

/**
 * 聊天记录同步协调器。
 * - initial：初次连接成功 → 全量同步 WeFlow 聊天记录到库。
 * - recovery：重连/恢复成功 → 仅补偿断连缺口。
 */
export interface SyncCoordinator {
    onConnected(reason: SyncReason): void
}

/** 告警事件（精简版，对齐需求文档 §8 AlertEvent） */
export interface AlertEvent {
    level: 'warn' | 'error'
    type: string
    title: string
    message: string
}

/** 告警通道抽象（首版仅 LogAlertChannel，写结构化日志） */
export interface AlertChannel {
    send(alert: AlertEvent): void
}

/** 仅记日志的同步协调器桩：真正的全量/补偿同步落地于 core/compensation 后替换。 */
export function createLogSyncCoordinator(log: Logger): SyncCoordinator {
    return {
        onConnected(reason) {
            const action = reason === 'initial' ? '全量同步' : '补偿同步'
            log.info({ reason, action }, `[sync] 连接成功，待执行${action}（占位：等 core/compensation 接入）`)
        },
    }
}

/** 仅记日志的告警通道（需求文档 §8 首版落地 LogAlertChannel） */
export function createLogAlertChannel(log: Logger): AlertChannel {
    return {
        send(alert) {
            const fn = alert.level === 'error' ? log.error : log.warn
            fn.call(log, { type: alert.type, title: alert.title }, `[alert] ${alert.message}`)
        },
    }
}
