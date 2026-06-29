import { describe, it, expect } from 'vitest'
import { isRevokeRow, isFileMessage, computeRevocableUntil } from './revoke.js'

// 真实样本（用户实测）：撤回行原地改写、文件 localType 打包整数
const REVOKE_RAW = '<?xml version="1.0"?><sysmsg type="revokemsg"><revokemsg><content>"无心" 撤回了一条消息</content><revoketime>0</revoketime></revokemsg></sysmsg>'
const PDF_RAW = 'wxid_x:\n<?xml version="1.0"?>\n<msg>\n\t<appmsg appid="wx" sdkver="0">\n\t\t<title>x.pdf</title>\n\t\t<type>6</type>\n\t\t<appattach>\n\t\t\t<totallen>35624</totallen>\n\t\t\t<fileext>pdf</fileext>\n\t\t</appattach>\n\t</appmsg>\n</msg>\n'
const IMG_RAW = '<?xml version="1.0"?><msg><img length="74592" aeskey="x"/><commenturl/></msg>'

describe('isRevokeRow — 撤回行识别', () => {
    it('localType 10000 + revokemsg sysmsg → true', () => {
        expect(isRevokeRow({ localType: 10000, content: REVOKE_RAW, rawContent: REVOKE_RAW })).toBe(true)
    })

    it('revokemsg 只在 rawContent 里（content 为占位）也认得', () => {
        expect(isRevokeRow({ localType: 10000, content: '', rawContent: REVOKE_RAW })).toBe(true)
    })

    it('普通文字消息 → false', () => {
        expect(isRevokeRow({ localType: 1, content: '1', rawContent: 'wxid_x:\n1' })).toBe(false)
    })

    it('系统消息但是群改名（非撤回）→ false', () => {
        expect(isRevokeRow({ localType: 10000, content: '你修改群名为“X”', rawContent: '你修改群名为“X”' })).toBe(false)
    })

    it('文件消息（大整数 localType）→ false（不会被当撤回）', () => {
        expect(isRevokeRow({ localType: 25769803825, content: PDF_RAW, rawContent: PDF_RAW })).toBe(false)
    })
})

describe('isFileMessage — 文件消息判定', () => {
    it('PDF：localType (6<<32)|49 + <appattach><fileext> → true', () => {
        expect(isFileMessage({ localType: 25769803825, content: PDF_RAW, rawContent: PDF_RAW })).toBe(true)
    })

    it('图片 localType 3 → false', () => {
        expect(isFileMessage({ localType: 3, content: '[图片]', rawContent: IMG_RAW })).toBe(false)
    })

    it('表情 localType 47 → false', () => {
        expect(isFileMessage({ localType: 47, content: '[表情]', rawContent: '<msg><emoji/></msg>' })).toBe(false)
    })

    it('文字 localType 1 → false', () => {
        expect(isFileMessage({ localType: 1, content: '1', rawContent: 'wxid_x:\n1' })).toBe(false)
    })

    it('链接 appmsg（type 5）→ false（仅文件 type 6 才算）', () => {
        const linkRaw = '<msg><appmsg><type>5</type><url>http://x</url></appmsg></msg>'
        // (5<<32)|49 = 21474836529
        expect(isFileMessage({ localType: 21474836529, content: linkRaw, rawContent: linkRaw })).toBe(false)
    })
})

describe('computeRevocableUntil — 撤回截止时间', () => {
    const NOW = 1782715253

    it('普通消息：createTime + 2min + 30s grace', () => {
        expect(computeRevocableUntil({ localType: 1, createTime: NOW, rawContent: 'wxid_x:\n1' }, NOW))
            .toBe(NOW + 120 + 30)
    })

    it('文件消息：createTime + 3h + 30s grace', () => {
        expect(computeRevocableUntil({ localType: 25769803825, createTime: NOW, rawContent: PDF_RAW }, NOW))
            .toBe(NOW + 3 * 3600 + 30)
    })

    it('已过撤回窗口的老消息 → null（不进扫描）', () => {
        expect(computeRevocableUntil({ localType: 1, createTime: NOW - 1000, rawContent: 'wxid_x:\n1' }, NOW))
            .toBeNull()
    })

    it('系统消息（localType 10000）→ null（不盯撤回）', () => {
        expect(computeRevocableUntil({ localType: 10000, createTime: NOW, rawContent: REVOKE_RAW }, NOW))
            .toBeNull()
    })

    it('缺 createTime → null', () => {
        expect(computeRevocableUntil({ localType: 1, rawContent: 'wxid_x:\n1' }, NOW)).toBeNull()
    })
})
