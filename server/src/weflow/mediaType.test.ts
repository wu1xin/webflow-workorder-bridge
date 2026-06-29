import { describe, it, expect } from 'vitest'
import { unpackLocalType, classifyMedia, isFileMessage } from './mediaType.js'

// 真实样本（用户实测 /api/v1/messages）：文件 localType 打包整数 (6<<32)|49，rawContent 带 <appattach><fileext>
const PDF_RAW = 'wxid_x:\n<?xml version="1.0"?>\n<msg>\n\t<appmsg appid="wx">\n\t\t<title>x.pdf</title>\n\t\t<type>6</type>\n\t\t<appattach>\n\t\t\t<totallen>35624</totallen>\n\t\t\t<fileext>pdf</fileext>\n\t\t</appattach>\n\t</appmsg>\n</msg>\n'
// 引用消息：(57<<32)|49，appmsg type 57，无 appattach
const QUOTE_RAW = 'wxid_x:\n<msg><appmsg><title>ggg</title><type>57</type><appattach /></appmsg></msg>'
// 链接 appmsg：(5<<32)|49
const LINK_RAW = '<msg><appmsg><type>5</type><url>http://x</url></appmsg></msg>'

describe('unpackLocalType — 拆打包 localType', () => {
    it('非 appmsg：sub=0', () => {
        expect(unpackLocalType(3)).toEqual({ base: 3, sub: 0 })
    })

    it('文件 (6<<32)|49 → base 49 / sub 6', () => {
        expect(unpackLocalType(25769803825)).toEqual({ base: 49, sub: 6 })
    })

    it('引用 (57<<32)|49 → base 49 / sub 57', () => {
        expect(unpackLocalType(244813135921)).toEqual({ base: 49, sub: 57 })
    })
})

describe('classifyMedia — 媒体语义分类（只认 localType）', () => {
    it('文本 localType 1 → null', () => {
        expect(classifyMedia({ localType: 1, content: 'hi', rawContent: 'wxid_x:\nhi' })).toBeNull()
    })

    it('图片 localType 3 → image', () => {
        expect(classifyMedia({ localType: 3, content: '[图片]' })).toBe('image')
    })

    it('语音 localType 34 → voice', () => {
        expect(classifyMedia({ localType: 34 })).toBe('voice')
    })

    it('视频 localType 43 → video', () => {
        expect(classifyMedia({ localType: 43, content: '[视频]' })).toBe('video')
    })

    it('动画表情 localType 47 → emoji', () => {
        expect(classifyMedia({ localType: 47, content: '[动画表情]' })).toBe('emoji')
    })

    it('文件 (6<<32)|49 + appattach → file', () => {
        expect(classifyMedia({ localType: 25769803825, content: '[文件]', rawContent: PDF_RAW })).toBe('file')
    })

    it('文件子类型但缺 appattach → null（双保险拦下）', () => {
        expect(classifyMedia({ localType: 25769803825, content: '[文件]', rawContent: '<msg><appmsg><type>6</type></appmsg></msg>' })).toBeNull()
    })

    it('引用 (57<<32)|49 → null', () => {
        expect(classifyMedia({ localType: 244813135921, content: 'ggg', rawContent: QUOTE_RAW })).toBeNull()
    })

    it('链接 (5<<32)|49 → null', () => {
        expect(classifyMedia({ localType: 21474836529, content: 'x', rawContent: LINK_RAW })).toBeNull()
    })

    it('系统消息 localType 10000 → null', () => {
        expect(classifyMedia({ localType: 10000, content: '系统提示' })).toBeNull()
    })

    it('缺 localType → null', () => {
        expect(classifyMedia({ content: 'hi' })).toBeNull()
    })
})

describe('isFileMessage — 文件消息判定（撤回 3h 窗口用）', () => {
    it('PDF：(6<<32)|49 + <appattach><fileext> → true', () => {
        expect(isFileMessage({ localType: 25769803825, content: '[文件]', rawContent: PDF_RAW })).toBe(true)
    })

    it('图片 localType 3 → false', () => {
        expect(isFileMessage({ localType: 3, content: '[图片]' })).toBe(false)
    })

    it('链接 (5<<32)|49 → false（仅文件 type 6 才算）', () => {
        expect(isFileMessage({ localType: 21474836529, content: 'x', rawContent: LINK_RAW })).toBe(false)
    })
})
