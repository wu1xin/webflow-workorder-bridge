import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from './circuitBreaker.js'

describe('CircuitBreaker', () => {
    it('连续失败达阈值 → 打开；冷却期内 isOpen=true', () => {
        let t = 1000
        const cb = new CircuitBreaker(3, 30, () => t)
        cb.recordFailure(); cb.recordFailure(); expect(cb.isOpen()).toBe(false)
        cb.recordFailure(); expect(cb.isOpen()).toBe(true)
        t = 1020; expect(cb.isOpen()).toBe(true)
        t = 1031; expect(cb.isOpen()).toBe(false)
    })
    it('成功复位', () => {
        let t = 1000
        const cb = new CircuitBreaker(2, 30, () => t)
        cb.recordFailure(); cb.recordFailure(); expect(cb.isOpen()).toBe(true)
        cb.recordSuccess(); expect(cb.isOpen()).toBe(false)
        expect(cb.state()).toBe('closed')
    })
    it('半开探测再失败 → 重新打开', () => {
        let t = 1000
        const cb = new CircuitBreaker(1, 30, () => t)
        cb.recordFailure(); expect(cb.isOpen()).toBe(true)
        t = 1031; expect(cb.isOpen()).toBe(false)
        cb.recordFailure(); t = 1032; expect(cb.isOpen()).toBe(true)
    })
    it('半开探测成功 → 关闭', () => {
        let t = 1000
        const cb = new CircuitBreaker(1, 30, () => t)
        cb.recordFailure(); expect(cb.isOpen()).toBe(true); expect(cb.state()).toBe('open')
        t = 1031; expect(cb.isOpen()).toBe(false); expect(cb.state()).toBe('half-open') // 半开
        cb.recordSuccess(); expect(cb.state()).toBe('closed')
    })
})
