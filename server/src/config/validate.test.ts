import { describe, it, expect } from 'vitest'
import { validateDownstreamUpdate, validateWeflowUpdate } from './validate.js'

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
    it('aesKey 尾随空格 trim 后不足 16 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, aesKey: 'abcdefghijkl    ' }).errors.aesKey).toBeTruthy() // 12 字符+4 空格
    })
    it('baseUrl 协议非 http/https → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, baseUrl: 'ftp://host/x' }).errors.baseUrl).toBeTruthy()
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
    it('forwarder.mediaEnabled 非布尔 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, forwarder: { mediaEnabled: 'yes' as unknown as boolean } }).errors['forwarder.mediaEnabled']).toBeTruthy()
    })
    it('forwarder.mediaEnabled 布尔通过；mediaWaitCapSec 合法通过', () => {
        expect(validateDownstreamUpdate({ ...ok, forwarder: { mediaEnabled: true, mediaWaitCapSec: 300 } }).ok).toBe(true)
    })
    it('forwarder.mediaWaitCapSec 越界 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, forwarder: { mediaWaitCapSec: 10 } }).errors['forwarder.mediaWaitCapSec']).toBeTruthy()
    })
})

describe('validateWeflowUpdate — fileBaseDir', () => {
    const ok = {
        host: '127.0.0.1', port: 5031, accessToken: 'tok',
        connectTimeoutSec: 10, readTimeoutSec: 60, firstMessageTimeoutSec: 10,
        reconnectIntervalSec: 1, reconnectLogIntervalSec: 30,
    }
    it('不带 fileBaseDir 通过（可选）', () => {
        expect(validateWeflowUpdate(ok).ok).toBe(true)
    })
    it('fileBaseDir 为非空字符串通过', () => {
        expect(validateWeflowUpdate({ ...ok, fileBaseDir: 'C:\\x\\msg\\file' }).ok).toBe(true)
    })
    it('fileBaseDir 为空白字符串 → 报错', () => {
        expect(validateWeflowUpdate({ ...ok, fileBaseDir: '   ' }).errors.fileBaseDir).toBeTruthy()
    })
})
