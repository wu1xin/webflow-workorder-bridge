import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveMediaSource, fileMonthFolder } from './mediaSource.js'
import type { WeflowMessage } from '../weflow/restClient.js'

// 文件 appmsg：localType (6<<32)|49，rawContent 带 <title>/<totallen>/<fileext>
function fileRaw(title: string, totallen: number): string {
    return `wxid_x:\n<msg><appmsg><title>${title}</title><type>6</type>`
        + `<appattach><totallen>${totallen}</totallen><fileext>epub</fileext></appattach></appmsg></msg>`
}

describe('fileMonthFolder', () => {
    it('按本地时区把 createTime 折成 YYYY-MM', () => {
        const d = new Date(2026, 6, 9, 12, 0, 0) // 本地 2026-07
        expect(fileMonthFolder(Math.floor(d.getTime() / 1000))).toBe('2026-07')
    })
})

describe('resolveMediaSource — 图/语/表情（读 mediaLocalPath）', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('图片 mediaLocalPath 存在 → ready', () => {
        const p = join(dir, 'a.jpg')
        writeFileSync(p, 'imgbytes')
        const msg: WeflowMessage = { localType: 3, content: '[图片]', mediaFileName: 'a.jpg', mediaLocalPath: p }
        const r = resolveMediaSource(msg, {})
        expect(r).toEqual({ status: 'ready', absPath: p, fileName: 'a.jpg', mediaType: 'image' })
    })

    it('语音 mediaLocalPath 字段缺失 → waiting', () => {
        const r = resolveMediaSource({ localType: 34, content: '[语音消息]' }, {})
        expect(r.status).toBe('waiting')
    })

    it('图片 mediaLocalPath 指向不存在的文件 → waiting', () => {
        const msg: WeflowMessage = { localType: 3, mediaFileName: 'a.jpg', mediaLocalPath: join(dir, 'missing.jpg') }
        expect(resolveMediaSource(msg, {}).status).toBe('waiting')
    })
})

describe('resolveMediaSource — 文件（fileBaseDir + 月份 + title，size==totallen）', () => {
    let base: string
    const create = new Date(2026, 6, 9, 12).getTime() / 1000
    const month = fileMonthFolder(create)
    beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'fb-')) })
    afterEach(() => rmSync(base, { recursive: true, force: true }))

    function putFile(monthDir: string, name: string, bytes: string): void {
        const d = join(base, monthDir)
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, name), bytes)
    }

    it('主路径命中且 size==totallen → ready', () => {
        putFile(month, 'x.epub', 'hello world!') // 12 字节
        const msg: WeflowMessage = { localType: 25769803825, createTime: create, rawContent: fileRaw('x.epub', 12) }
        const r = resolveMediaSource(msg, { fileBaseDir: base })
        expect(r).toEqual({ status: 'ready', absPath: join(base, month, 'x.epub'), fileName: 'x.epub', mediaType: 'file' })
    })

    it('文件存在但 size != totallen（半下载）→ waiting', () => {
        putFile(month, 'x.epub', 'half') // 4 字节 ≠ 12
        const msg: WeflowMessage = { localType: 25769803825, createTime: create, rawContent: fileRaw('x.epub', 12) }
        expect(resolveMediaSource(msg, { fileBaseDir: base }).status).toBe('waiting')
    })

    it('文件尚未落盘 → waiting', () => {
        const msg: WeflowMessage = { localType: 25769803825, createTime: create, rawContent: fileRaw('x.epub', 12) }
        expect(resolveMediaSource(msg, { fileBaseDir: base }).status).toBe('waiting')
    })

    it('未配置 fileBaseDir → unsupported', () => {
        const msg: WeflowMessage = { localType: 25769803825, createTime: create, rawContent: fileRaw('x.epub', 12) }
        expect(resolveMediaSource(msg, {}).status).toBe('unsupported')
    })

    it('主路径未命中，回退上月目录扫到（文件名+size 匹配）→ ready', () => {
        const prev = fileMonthFolder(new Date(2026, 5, 30, 12).getTime() / 1000) // 上月 2026-06
        putFile(prev, 'x.epub', 'hello world!')
        const msg: WeflowMessage = { localType: 25769803825, createTime: create, rawContent: fileRaw('x.epub', 12) }
        const r = resolveMediaSource(msg, { fileBaseDir: base })
        expect(r).toEqual({ status: 'ready', absPath: join(base, prev, 'x.epub'), fileName: 'x.epub', mediaType: 'file' })
    })
})

describe('resolveMediaSource — 不支持类型', () => {
    it('视频 localType 43 → unsupported', () => {
        expect(resolveMediaSource({ localType: 43, content: '[视频]' }, {}).status).toBe('unsupported')
    })
    it('文本 localType 1 → unsupported', () => {
        expect(resolveMediaSource({ localType: 1, content: 'hi' }, {}).status).toBe('unsupported')
    })
})
