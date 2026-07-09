import { describe, it, expect } from 'vitest'
import { decideOutcome, isDownstreamUnavailable, type SendResult } from './forwardPolicy.js'

const POLICY = { maxAttempts: 3, authMaxAttempts: 2, backoffBaseMs: 2000, backoffCapMs: 60000 }
const ack = (code: number, retryable?: boolean): SendResult => ({ type: 'ack', ack: { code, retryable, duplicate: code === 1 } })
const transport = (): SendResult => ({ type: 'transport', error: 'timeout' })

describe('decideOutcome', () => {
    it('code=1 → done（带 duplicate）', () => {
        expect(decideOutcome({ type: 'ack', ack: { code: 1, duplicate: true } }, 0, POLICY)).toEqual({ kind: 'done', duplicate: true })
    })
    it('code=0 可重试且未耗尽 → retry（退避递增）', () => {
        const o = decideOutcome(ack(0), 0, POLICY)
        expect(o.kind).toBe('retry')
        if (o.kind === 'retry') expect(o.backoffMs).toBe(2000)
    })
    it('可重试耗尽 maxAttempts → dead', () => {
        expect(decideOutcome(ack(1005), 2, POLICY).kind).toBe('dead')
    })
    it('1002/1003 立即 dead（failCode 落库）', () => {
        expect(decideOutcome(ack(1002), 0, POLICY)).toMatchObject({ kind: 'dead', failCode: 1002 })
        expect(decideOutcome(ack(1003), 0, POLICY).kind).toBe('dead')
    })
    it('1001 有限重试（authMaxAttempts=2）：第1次 retry、第2次 dead（failCode 落库）', () => {
        expect(decideOutcome(ack(1001), 0, POLICY).kind).toBe('retry')
        expect(decideOutcome(ack(1001), 1, POLICY)).toMatchObject({ kind: 'dead', failCode: 1001 })
    })
    it('显式 retryable=false → dead；retryable=true → retry', () => {
        expect(decideOutcome(ack(0, false), 0, POLICY).kind).toBe('dead')
        expect(decideOutcome(ack(9999, true), 0, POLICY).kind).toBe('retry')
    })
    it('传输层错误恒定 retry、永不进死信（下游临时不可用不烧死信预算）', () => {
        const o = decideOutcome(transport(), 0, POLICY)
        expect(o).toMatchObject({ kind: 'retry', failCode: null })
        if (o.kind === 'retry') expect(o.lastError).toContain('timeout')
        // attempts 远超 maxAttempts 仍是 retry，退避封顶在 backoffCapMs
        const o2 = decideOutcome(transport(), 99, POLICY)
        expect(o2.kind).toBe('retry')
        if (o2.kind === 'retry') expect(o2.backoffMs).toBe(60000)
    })
    it('退避指数增长且封顶', () => {
        const b = (n: number) => { const o = decideOutcome(ack(0), n, { ...POLICY, maxAttempts: 99 }); return o.kind === 'retry' ? o.backoffMs : -1 }
        expect(b(0)).toBe(2000); expect(b(1)).toBe(4000); expect(b(2)).toBe(8000)
        expect(b(20)).toBe(60000)
    })
})

describe('isDownstreamUnavailable', () => {
    it('传输错误与 0/1004/1005/未识别码 计入熔断；1001/1002/1003 不计', () => {
        expect(isDownstreamUnavailable(transport())).toBe(true)
        expect(isDownstreamUnavailable(ack(0))).toBe(true)
        expect(isDownstreamUnavailable(ack(1005))).toBe(true)
        expect(isDownstreamUnavailable(ack(1001))).toBe(false)
        expect(isDownstreamUnavailable(ack(1002))).toBe(false)
        expect(isDownstreamUnavailable(ack(1))).toBe(false)
    })
})
