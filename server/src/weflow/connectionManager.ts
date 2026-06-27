// WeFlow 上游连接管理器：状态机 + 初次连接 + 运行期掉线最终判断 + 固定间隔重连循环。
// 完整逻辑见 docs/weflow-链路连接逻辑（仅上游）.md（§1 未配置、§2 初次、§3 运行中、§4 重连循环、§5 恢复）。
//
// 三个连接场景都复用三级判定闸门（runConnectionGate），区别只在「失败后是否记日志/告警/重连」：
//   - 初次保存并连接：失败仅报前端，不记日志/告警/重连（交还给人）。
//   - 运行中掉线最终判断：失败一律记日志 + 告警，并自动进入重连循环。
//   - 重连循环：固定 intervalSec 重跑，每 logIntervalSec 汇总一条日志，直到连回。
import { EventEmitter } from 'node:events'
import type { ConfigStore } from '../config/store.js'
import type { WeflowConfig } from '@wb/shared/types'
import { runConnectionGate, type GateResult } from './gate.js'
import { SseClient, type SseCloseReason, type SseEvent } from './sseClient.js'
import type { AlertChannel, SyncCoordinator, SyncReason } from './hooks.js'
import type { Logger } from './logger.js'
import type { ReconnectProgress, WeflowConnectionStatus } from './types.js'
import { redactToken, sseUrl } from './types.js'
// 运行期状态机枚举：取常量值复用，避免散落字面量（值与同名类型同处一个 const-object）。
import { WeflowConnectionState } from '@wb/shared/constants'

/** 触发一次（重）连接的来源 */
type RestartTrigger = 'boot' | 'config' | 'manual'

/** 秒级 Unix 时间戳 */
function nowSec(): number {
    return Math.floor(Date.now() / 1000)
}

export interface ConnectionManagerDeps {
    store: ConfigStore
    log: Logger
    sync: SyncCoordinator
    alert: AlertChannel
}

/**
 * 连接管理器。继承 EventEmitter，状态每次变化时发出 `status` 事件，
 * 供 GET /api/stream/status 实时下推前端（FR-CONN-06）。
 */
export class WeflowConnectionManager extends EventEmitter {
    private readonly store: ConfigStore
    private readonly log: Logger
    private readonly sync: SyncCoordinator
    private readonly alert: AlertChannel

    private status: WeflowConnectionStatus = {
        state: WeflowConnectionState.unconfigured,
        diagnosis: null,
        lastConnectedAt: null,
        message: null,
        reconnect: null,
    }

    /** 当前存活的 SSE 连接（仅 connected 态非空） */
    private liveClient: SseClient | null = null
    /** 是否曾成功连上：用于区分「初次连接」(全量同步) 与「重连恢复」(补偿同步)，及失败后是否重连 */
    private everConnected = false

    /** epoch 用于作废过期的异步续作：每次 restart 自增，旧的闸门/循环回调发现 epoch 变了即退出 */
    private epoch = 0
    /** 重连循环是否在跑 */
    private reconnecting = false
    private reconnectTimer: NodeJS.Timeout | null = null
    /** 重连日志汇总窗口起点（秒）与窗口内尝试数 */
    private logWindowStart = 0
    private logWindowAttempts = 0

    constructor(deps: ConnectionManagerDeps) {
        super()
        this.store = deps.store
        this.log = deps.log
        this.sync = deps.sync
        this.alert = deps.alert
    }

    /** 当前状态快照（拷贝） */
    getStatus(): WeflowConnectionStatus {
        return { ...this.status, reconnect: this.status.reconnect ? { ...this.status.reconnect } : null }
    }

    /** 订阅状态变化（GET /api/stream/status 用）。返回取消订阅函数 */
    onStatusChange(listener: (status: WeflowConnectionStatus) => void): () => void {
        this.on('status', listener)
        return () => this.off('status', listener)
    }

    /** 发出状态变化事件（携带快照拷贝） */
    private emitStatus(): void {
        this.emit('status', this.getStatus())
    }

    /** 启动时调用：有可用配置则发起初次连接，否则停在「未配置」态（§1） */
    start(): void {
        if (!this.store.isConnectable()) {
            this.setState(WeflowConnectionState.unconfigured, { message: '未配置 WeFlow 连接参数' })
            this.log.info('[weflow] 未配置连接参数，停在未配置态，等待前端填写')
            return
        }
        void this.restart('boot')
    }

    /** 配置保存后触发热重连（§2 初次 / §5a 保存并重连 / 配置说明 §8） */
    applyConfig(): void {
        void this.restart('config')
    }

    /** 手动重连（FR-CONN-09 / POST /api/control/reconnect） */
    manualReconnect(): void {
        void this.restart('manual')
    }

    /** 取当前连接参数；仅在 isConnectable() 通过后调用，未配置属调用方时序错误 */
    private cfg(): WeflowConfig {
        const w = this.store.getWeflow()
        if (!w) throw new Error('[weflow] 上游未配置，无法获取连接参数')
        return w
    }

    /**
     * 统一的（重）连接入口：拆掉现有连接/循环，跑一次三级闸门。
     * 成功 → 连上并按场景同步；失败 → 视「是否曾连上」决定仅报前端 or 进重连循环。
     */
    private async restart(trigger: RestartTrigger): Promise<void> {
        const epoch = ++this.epoch
        this.teardown()

        if (!this.store.isConnectable()) {
            this.setState(WeflowConnectionState.unconfigured, { message: '未配置 WeFlow 连接参数' })
            return
        }

        this.setState(WeflowConnectionState.connecting, { message: '正在连接 WeFlow…' })
        this.log.info({ trigger, target: redactToken(sseUrl(this.cfg())) }, '[weflow] 开始三级连接判定')
        const result = await runConnectionGate(this.cfg(), { keepAlive: true })

        // 期间有更新的 restart 抢先了 → 作废本轮，关掉可能拿到的连接
        if (epoch !== this.epoch) {
            result.client?.close()
            return
        }

        if (result.ok) {
            this.onConnected(result, this.everConnected ? 'recovery' : 'initial', epoch)
            return
        }

        if (this.everConnected) {
            // 运行期/恢复重连失败：记日志 + 告警 + 进重连循环（§3/§4）
            this.logFailure('掉线重连失败', result, trigger)
            this.alert.send({
                level: 'error',
                type: 'weflow_disconnected',
                title: 'WeFlow 连接断开',
                message: `${result.failureLabel ?? result.diagnosis}：${result.message}`,
            })
            this.enterReconnectLoop(result, epoch)
        } else {
            // 初次连接失败：仅报前端，不记日志/告警/重连，交还给人（§2）
            this.setFailedState(result)
        }
    }

    /** 三级全过：转入「已连接 · 接收中」，挂监听，按场景触发同步（§2 全量 / §5 补偿） */
    private onConnected(result: GateResult, reason: SyncReason, epoch: number): void {
        const client = result.client
        if (!client) return

        this.stopReconnectLoop()
        this.liveClient = client
        this.everConnected = true

        // 连接保持期间每条 SSE 事件 → 实时回查入库（实时流）
        client.on('event', (evt: SseEvent) => this.sync.onSseEvent(evt))
        // 运行期掉线（读超时/流错误/服务端结束）→ 触发最终判断
        client.on('close', (closeReason: SseCloseReason) => {
            if (epoch !== this.epoch || this.liveClient !== client) return // 已被新连接取代
            this.onLiveClientClosed(closeReason, epoch)
        })
        client.on('timeout', () => {
            this.log.warn({ readTimeoutSec: this.cfg().readTimeoutSec }, `[weflow] 读超时窗口(${this.cfg().readTimeoutSec}s)内无数据，疑似掉线`)
        })
        client.on('error', (err: Error) => {
            this.log.warn({ err: err.message }, '[weflow] SSE 流读取出错')
        })

        this.setState(WeflowConnectionState.connected, {
            diagnosis: null,
            lastConnectedAt: nowSec(),
            message: '已连接 · 接收中',
            reconnect: null,
        })
        this.log.info({ elapsedMs: result.elapsedMs, reason }, '[weflow] 已连接 · 接收中')
        this.sync.onConnected(reason)
    }

    /** 运行中已连接态下连接断开（§3）：重试 health 走最终判断 */
    private onLiveClientClosed(reason: SseCloseReason, epoch: number): void {
        this.liveClient = null
        this.log.warn({ reason }, '[weflow] 运行期连接断开，触发最终判断')
        void this.runFinalJudgment(epoch)
    }

    /** 最终判断（§3）：再跑一次三级闸门。成功→恢复(补偿同步)；失败→记日志+告警+进重连循环 */
    private async runFinalJudgment(epoch: number): Promise<void> {
        if (epoch !== this.epoch) return
        this.setState(WeflowConnectionState.connecting, { message: '疑似掉线，重试 health 做最终判断…' })
        const result = await runConnectionGate(this.cfg(), { keepAlive: true })
        if (epoch !== this.epoch) {
            result.client?.close()
            return
        }
        if (result.ok) {
            this.log.info('[weflow] 最终判断三级全过，直接连回（恢复）')
            this.onConnected(result, 'recovery', epoch)
            return
        }
        this.logFailure('最终判断失败', result, 'boot')
        this.alert.send({
            level: 'error',
            type: 'weflow_disconnected',
            title: 'WeFlow 连接断开',
            message: `${result.failureLabel ?? result.diagnosis}：${result.message}`,
        })
        this.enterReconnectLoop(result, epoch)
    }

    /** 进入自动重连循环（§4）：固定间隔重跑闸门，每 logIntervalSec 汇总一条日志 */
    private enterReconnectLoop(lastResult: GateResult, epoch: number): void {
        this.reconnecting = true
        this.logWindowStart = nowSec()
        this.logWindowAttempts = 0
        const reconnect: ReconnectProgress = {
            intervalSec: this.cfg().reconnectIntervalSec,
            attempts: 0,
            since: nowSec(),
        }
        this.setState(WeflowConnectionState.reconnecting, {
            diagnosis: lastResult.diagnosis,
            message: `自动重连中（${lastResult.failureLabel ?? lastResult.diagnosis}）`,
            reconnect,
        })
        this.log.warn({ intervalSec: reconnect.intervalSec }, '[weflow] 进入自动重连循环（固定间隔，不退避）')
        this.scheduleReconnectAttempt(epoch)
    }

    private scheduleReconnectAttempt(epoch: number): void {
        const delayMs = this.cfg().reconnectIntervalSec * 1000
        this.reconnectTimer = setTimeout(() => {
            void this.runReconnectAttempt(epoch)
        }, delayMs)
    }

    private async runReconnectAttempt(epoch: number): Promise<void> {
        if (!this.reconnecting || epoch !== this.epoch) return

        this.logWindowAttempts += 1
        if (this.status.reconnect) {
            this.status.reconnect.attempts += 1
            this.emitStatus()
        }

        const result = await runConnectionGate(this.cfg(), { keepAlive: true })
        if (!this.reconnecting || epoch !== this.epoch) {
            result.client?.close()
            return
        }

        this.maybeLogReconnectWindow(result)

        if (result.ok) {
            this.log.info('[weflow] 重连成功，恢复连接')
            this.onConnected(result, 'recovery', epoch)
            return
        }

        // 仍失败：更新诊断并安排下一轮
        if (this.status.reconnect) {
            this.status = {
                ...this.status,
                diagnosis: result.diagnosis,
                message: `自动重连中（${result.failureLabel ?? result.diagnosis}）`,
            }
            this.emitStatus()
        }
        this.scheduleReconnectAttempt(epoch)
    }

    /** 每 logIntervalSec 汇总一条「重连测试」日志（§4） */
    private maybeLogReconnectWindow(latest: GateResult): void {
        const elapsed = nowSec() - this.logWindowStart
        if (elapsed < this.cfg().reconnectLogIntervalSec) return
        this.log.warn(
            {
                windowSec: elapsed,
                attempts: this.logWindowAttempts,
                totalAttempts: this.status.reconnect?.attempts ?? 0,
                latestDiagnosis: latest.diagnosis,
            },
            `[weflow] 重连测试：近 ${elapsed}s 内尝试 ${this.logWindowAttempts} 次，仍未连回（最新：${latest.failureLabel ?? latest.diagnosis}）`,
        )
        this.logWindowStart = nowSec()
        this.logWindowAttempts = 0
    }

    /** 初次连接失败：置失败态，仅供前端读取（不记日志/告警/重连） */
    private setFailedState(result: GateResult): void {
        const state: WeflowConnectionState
            = result.diagnosis === 'weflow_not_ready' || result.diagnosis === 'connected_no_push'
                ? WeflowConnectionState.weflowNotReady
                : WeflowConnectionState.disconnected
        this.setState(state, {
            diagnosis: result.diagnosis,
            message: result.message,
            reconnect: null,
        })
    }

    /** 记录失败日志（带 token 脱敏的上下文） */
    private logFailure(scene: string, result: GateResult, trigger: RestartTrigger): void {
        this.log.error(
            {
                scene,
                trigger,
                diagnosis: result.diagnosis,
                failureLabel: result.failureLabel,
                elapsedMs: result.elapsedMs,
            },
            `[weflow] ${scene}：${result.message}`,
        )
    }

    private stopReconnectLoop(): void {
        this.reconnecting = false
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    /** 拆除当前连接与重连循环（不发告警，供 restart 前清场） */
    private teardown(): void {
        this.stopReconnectLoop()
        if (this.liveClient) {
            this.liveClient.removeAllListeners()
            this.liveClient.close('manual')
            this.liveClient = null
        }
    }

    /** 更新状态快照（部分字段，其余保持），并发出状态变化事件 */
    private setState(state: WeflowConnectionState, patch: Partial<Omit<WeflowConnectionStatus, 'state'>>): void {
        this.status = {
            state,
            diagnosis: patch.diagnosis !== undefined ? patch.diagnosis : this.status.diagnosis,
            lastConnectedAt: patch.lastConnectedAt !== undefined ? patch.lastConnectedAt : this.status.lastConnectedAt,
            message: patch.message !== undefined ? patch.message : this.status.message,
            reconnect: patch.reconnect !== undefined ? patch.reconnect : this.status.reconnect,
        }
        this.emitStatus()
    }
}
