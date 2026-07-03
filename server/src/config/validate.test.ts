import { describe, it, expect } from 'vitest'
import { validateDownstreamUpdate } from './validate.js'

describe('validateDownstreamUpdate', () => {
    const ok = { baseUrl: 'https://dn.example.com', siteKey: 'site', aesKey: 'sixteen-byte-key' }
    it('合法配置通过', () => {
        expect(validateDownstreamUpdate(ok).ok).toBe(true)
    })
    it('baseUrl 非法 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, baseUrl: 'not a url' }).errors.baseUrl).toBeTruthy()
    })
    it('aesKey 不足 16 字节 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, aesKey: 'short' }).errors.aesKey).toBeTruthy()
    })
    it('siteKey 空 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, siteKey: '' }).errors.siteKey).toBeTruthy()
    })
    it('forwarder 数值越界 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, forwarder: { maxAttempts: 0 } }).errors['forwarder.maxAttempts']).toBeTruthy()
    })
    it('forwarder 合法值通过', () => {
        expect(validateDownstreamUpdate({ ...ok, forwarder: { maxAttempts: 3, backoffBaseMs: 2000, backoffCapMs: 60000 } }).ok).toBe(true)
    })
})
