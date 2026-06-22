// 三级闸门第 ②③ 步的底座：单条 SSE 连接的建链、解帧、读超时探活。
// 解帧规则见 FR-CONN-07：识别 event:/data: 行，空行分隔事件，多行 data 拼接，忽略 : 注释行。
// 读超时探活见 FR-CONN-05：readTimeoutSec 窗口内无任何字节即判为疑似假死。
import { EventEmitter } from 'node:events'
import type { WeflowConfig } from '@wb/shared/types'
import { sseUrl } from './types.js'

/** 解析出的一条 SSE 事件 */
export interface SseEvent {
    /** 事件名（event: 行；缺省为 'message'） */
    event: string
    /** data: 行拼接后的负载原文 */
    data: string
}

/** SSE 握手失败：携带 HTTP 状态码（若有），用于区分 token 失效（401/403） */
export class SseOpenError extends Error {
    constructor(message: string, public readonly status?: number) {
        super(message)
        this.name = 'SseOpenError'
    }
}

/** close 事件携带的原因 */
export type SseCloseReason = 'read-timeout' | 'stream-error' | 'server-end' | 'manual'

/**
 * 单条 WeFlow SSE 连接。事件：
 * - `open`：握手成功（收到 2xx 响应头）
 * - `event`(SseEvent)：解出一条完整 SSE 事件
 * - `timeout`：读超时窗口内无数据（随后会 close）
 * - `error`(Error)：流读取出错（随后会 close）
 * - `close`(SseCloseReason)：连接结束
 */
export class SseClient extends EventEmitter {
    private readonly cfg: WeflowConfig
    private readonly controller = new AbortController()
    private opened = false
    private closed = false
    private connectTimedOut = false
    private firstMessageReceived = false
    private readTimer: NodeJS.Timeout | null = null

    // 解帧累加器
    private eventName = ''
    private dataLines: string[] = []
    private hasFrameData = false
    private buffer = ''

    constructor(cfg: WeflowConfig) {
        super()
        this.cfg = cfg
    }

    /** 是否已收到首条事件（gate 第 ③ 步判定用） */
    get gotFirstMessage(): boolean {
        return this.firstMessageReceived
    }

    /**
     * 建链并等待握手完成（≤ connectTimeoutSec）。
     * 成功后开始后台读流与读超时看门狗；失败抛 {@link SseOpenError}。
     */
    async open(): Promise<void> {
        const connectMs = this.cfg.connectTimeoutSec * 1000
        const connectTimer = setTimeout(() => {
            this.connectTimedOut = true
            this.controller.abort()
        }, connectMs)

        let res: Response
        try {
            res = await fetch(sseUrl(this.cfg), {
                method: 'GET',
                headers: { Accept: 'text/event-stream' },
                signal: this.controller.signal,
            })
        } catch (e) {
            clearTimeout(connectTimer)
            if (this.connectTimedOut) {
                throw new SseOpenError(`SSE 握手超时（${this.cfg.connectTimeoutSec}s）`)
            }
            throw new SseOpenError(e instanceof Error ? e.message : String(e))
        }
        clearTimeout(connectTimer)

        if (!res.ok) {
            const status = res.status
            await res.text().catch(() => '')
            throw new SseOpenError(`SSE 握手失败（HTTP ${status}）`, status)
        }
        if (!res.body) {
            throw new SseOpenError('SSE 响应无 body')
        }

        this.opened = true
        this.startReadTimer()
        void this.readLoop(res.body)
        this.emit('open')
    }

    /**
     * 等待首条事件，≤ timeoutMs。
     * 收到返回 true；超时返回 false（连接保持不断，由调用方决定去留）；中途断开也返回 false。
     */
    waitForFirstMessage(timeoutMs: number): Promise<boolean> {
        if (this.firstMessageReceived) return Promise.resolve(true)
        if (this.closed) return Promise.resolve(false)
        return new Promise((resolve) => {
            const cleanup = (): void => {
                clearTimeout(timer)
                this.off('event', onEvent)
                this.off('close', onClose)
            }
            const onEvent = (): void => {
                cleanup()
                resolve(true)
            }
            const onClose = (): void => {
                cleanup()
                resolve(false)
            }
            const timer = setTimeout(() => {
                cleanup()
                resolve(false)
            }, timeoutMs)
            this.once('event', onEvent)
            this.once('close', onClose)
        })
    }

    /** 主动关闭连接 */
    close(reason: SseCloseReason = 'manual'): void {
        if (this.closed) return
        this.closed = true
        this.stopReadTimer()
        try {
            this.controller.abort()
        } catch {
            // 已中止，忽略
        }
        this.emit('close', reason)
    }

    /** 后台读取流并解帧 */
    private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader()
        const decoder = new TextDecoder()
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                // 收到任意字节即视为存活，重置读超时窗口
                this.resetReadTimer()
                this.buffer += decoder.decode(value, { stream: true })
                this.drainLines()
            }
            // 服务端正常结束流
            if (!this.closed) {
                this.closed = true
                this.stopReadTimer()
                this.emit('close', 'server-end' satisfies SseCloseReason)
            }
        } catch (e) {
            if (this.closed) return // 主动 abort 触发的读异常，close 已发出
            this.closed = true
            this.stopReadTimer()
            this.emit('error', e instanceof Error ? e : new Error(String(e)))
            this.emit('close', 'stream-error' satisfies SseCloseReason)
        }
    }

    /** 从缓冲区切出整行并逐行喂给解帧器 */
    private drainLines(): void {
        let idx = this.buffer.indexOf('\n')
        while (idx >= 0) {
            let line = this.buffer.slice(0, idx)
            this.buffer = this.buffer.slice(idx + 1)
            if (line.endsWith('\r')) line = line.slice(0, -1)
            this.handleLine(line)
            idx = this.buffer.indexOf('\n')
        }
    }

    /** SSE 单行解帧 */
    private handleLine(line: string): void {
        if (line === '') {
            this.dispatchFrame()
            return
        }
        if (line.startsWith(':')) {
            // 注释/心跳行：仅维持存活（read timer 已在收字节时重置），不入帧
            return
        }
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)

        if (field === 'event') {
            this.eventName = value
        } else if (field === 'data') {
            this.dataLines.push(value)
            this.hasFrameData = true
        }
        // id / retry 等字段对本服务无意义，忽略
    }

    /** 空行触发：派发累加的事件并复位累加器 */
    private dispatchFrame(): void {
        if (!this.hasFrameData && this.eventName === '') return
        const evt: SseEvent = {
            event: this.eventName || 'message',
            data: this.dataLines.join('\n'),
        }
        this.eventName = ''
        this.dataLines = []
        this.hasFrameData = false
        this.firstMessageReceived = true
        this.emit('event', evt)
    }

    private startReadTimer(): void {
        this.readTimer = setTimeout(() => {
            this.emit('timeout')
            this.close('read-timeout')
        }, this.cfg.readTimeoutSec * 1000)
    }

    private resetReadTimer(): void {
        this.stopReadTimer()
        if (!this.closed) this.startReadTimer()
    }

    private stopReadTimer(): void {
        if (this.readTimer) {
            clearTimeout(this.readTimer)
            this.readTimer = null
        }
    }
}
