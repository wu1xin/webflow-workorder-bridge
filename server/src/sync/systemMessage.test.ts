import { describe, it, expect } from 'vitest'
import { parseSystemEvent } from './systemMessage.js'

describe('parseSystemEvent — 群改名识别', () => {
    it('自己改名：你修改群名为“X”（全角引号、含业务 ID）', () => {
        expect(parseSystemEvent({ localType: 10000, content: '你修改群名为“zhizhuIP服务对接群-18266-7569”' }))
            .toEqual({ kind: 'group_renamed', newName: 'zhizhuIP服务对接群-18266-7569' })
    })

    it('别人改名：“张三”修改群名为“X”', () => {
        expect(parseSystemEvent({ localType: 10000, content: '“张三”修改群名为“项目群A”' }))
            .toEqual({ kind: 'group_renamed', newName: '项目群A' })
    })

    it('旧措辞：修改群聊名称为“X”', () => {
        expect(parseSystemEvent({ localType: 10000, content: '“李四”修改群聊名称为“新名”' }))
            .toEqual({ kind: 'group_renamed', newName: '新名' })
    })

    it('半角引号也能解析', () => {
        expect(parseSystemEvent({ localType: 10000, content: '你修改群名为"半角名"' }))
            .toEqual({ kind: 'group_renamed', newName: '半角名' })
    })

    it('非系统消息（localType≠10000）→ null（localType 闸门防误判）', () => {
        expect(parseSystemEvent({ localType: 1, content: '你修改群名为“X”' })).toBeNull()
    })

    it('系统消息但非改名（入群提示）→ null', () => {
        expect(parseSystemEvent({ localType: 10000, content: '“张三”邀请“李四”加入了群聊' })).toBeNull()
    })

    it('content 缺失 → null', () => {
        expect(parseSystemEvent({ localType: 10000 })).toBeNull()
    })

    it('改名为空串 → null（不产生空名事件）', () => {
        expect(parseSystemEvent({ localType: 10000, content: '你修改群名为“”' })).toBeNull()
    })
})
