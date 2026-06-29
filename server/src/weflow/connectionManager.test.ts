import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { runConnectionGate, type GateResult } from './gate.js'
import { WeflowConnectionManager } from './connectionManager.js'
import { WeflowConnectionState } from '@wb/shared/constants'
import type { WeflowConfig, WeflowConnectDiagnosis } from '@wb/shared/types'

// 闸门整体打桩：用例逐轮控制三级判定结果，绕开真实 health/SSE 网络。
vi.mock('./gate.js', () => ({ runConnectionGate: vi.fn() }))
const runGate = vi.mocked(runConnectionGate)

function cfg(over: Partial<WeflowConfig> = {}): WeflowConfig {
    return {
        host: '127.0.0.1',
        port: 5031,
        accessToken: 't',
        connectTimeoutSec: 10,
        readTimeoutSec: 60,
        firstMessageTimeoutSec: 3,
        reconnectIntervalSec: 0.01, // 10ms/轮，测试快进
        reconnectLogIntervalSec: 30,
        ...over,
    }
}

/** 一轮失败的闸门结果 */
function fail(diagnosis: WeflowConnectDiagnosis): GateResult {
    return {
        ok: false,
        healthOk: diagnosis !== 'weflow_not_ready',
        sseConnected: false,
        firstEventReceived: false,
        diagnosis,
        failureLabel: '失败',
        message: 'x',
        elapsedMs: 1,
        client: null,
    }
}

/** 一轮成功的闸门结果（带可挂监听的假 SSE 连接） */
function ok(): GateResult {
    const client = Object.assign(new EventEmitter(), { close: vi.fn() })
    return {
        ok: true,
        healthOk: true,
        sseConnected: true,
        firstEventReceived: true,
        diagnosis: 'ok',
        failureLabel: null,
        message: '连接正常',
        elapsedMs: 1,
        client: client as never,
    }
}

function makeManager() {
    const sync = { onConnected: vi.fn(), onSseEvent: vi.fn() }
    const alert = { send: vi.fn() }
    const log = { info() {}, warn() {}, error() {}, debug() {} }
    const store = { isConnectable: () => true, getWeflow: () => cfg() }
    const manager = new WeflowConnectionManager({
        store: store as never,
        log: log as never,
        sync: sync as never,
        alert: alert as never,
    })
    return { manager, sync, alert }
}

/** 轮询等待条件成立（替代固定 sleep） */
async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (fn()) return
        await new Promise(r => setTimeout(r, 5))
    }
    throw new Error('等待条件超时')
}

describe('WeflowConnectionManager · 启动时上游后起的自动连接', () => {
    beforeEach(() => runGate.mockReset())

    it('boot 首探上游未就绪：进入重连循环，上游就绪后自动连上并做全量同步', async () => {
        let upstreamReady = false
        runGate.mockImplementation(() => Promise.resolve(upstreamReady ? ok() : fail('weflow_not_ready')))
        const { manager, sync, alert } = makeManager()

        manager.start()
        // 首探失败后应进入「重连中」等待，而不是停在「未就绪」死等人工
        await waitFor(() => manager.getStatus().state === WeflowConnectionState.reconnecting)

        // 模拟上游 WeFlow 此刻才启动
        upstreamReady = true
        await waitFor(() => manager.getStatus().state === WeflowConnectionState.connected)

        expect(sync.onConnected).toHaveBeenCalledWith('initial') // 首次连上 = 全量同步
        expect(alert.send).not.toHaveBeenCalled() // 初次失败不告警
    })

    it('boot 首探网络错误(error)：同样进入重连循环并最终连上', async () => {
        let upstreamReady = false
        runGate.mockImplementation(() => Promise.resolve(upstreamReady ? ok() : fail('error')))
        const { manager, sync } = makeManager()

        manager.start()
        await waitFor(() => manager.getStatus().state === WeflowConnectionState.reconnecting)
        upstreamReady = true
        await waitFor(() => manager.getStatus().state === WeflowConnectionState.connected)

        expect(sync.onConnected).toHaveBeenCalledWith('initial')
    })

    it('boot 首探 token 失效：停在 disconnected，不进重连循环（上游随后就绪也不自动连）', async () => {
        let ready = false
        runGate.mockImplementation(() => Promise.resolve(ready ? ok() : fail('token_invalid')))
        const { manager, sync } = makeManager()

        manager.start()
        await waitFor(() => manager.getStatus().state === WeflowConnectionState.disconnected)

        ready = true
        await new Promise(r => setTimeout(r, 60)) // 若错误地进了循环，这段时间会变 connected
        expect(manager.getStatus().state).toBe(WeflowConnectionState.disconnected)
        expect(sync.onConnected).not.toHaveBeenCalled()
    })
})
