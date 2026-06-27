// 系统消息（微信 localType 10000）旁路解析框架：把系统通知尝试性解析为已知事件。
// 不影响转发链路——系统消息照旧入 queue；本模块只负责「识别」，副作用由调用方按事件分发处理。
//
// 扩展方式：
//   1) 新增一种事件 → 往 SystemEvent 联合加一支，并在下方加一条内容模式 + 解析分支。
//   2) 在 syncService 的 dispatchSystemEvent switch 里加对应处理。
// localType===10000 闸门是正则安全的关键：普通用户消息即便含「修改群名为」也不会是系统消息，不会误判。
import type { WeflowMessage } from '../weflow/restClient.js'

/** 微信系统消息的 localType */
const SYSTEM_LOCAL_TYPE = 10000

/**
 * 群改名内容形态（容错全角/半角引号、「群名 / 群聊名称」措辞）：
 *   你修改群名为“X” | “张三”修改群名为“X” | “李四”修改群聊名称为“X”
 * 非贪婪取第一对引号内的新名。
 */
const GROUP_RENAME_RE = /修改群(?:聊)?名(?:称)?为[“"「『](.+?)[”"」』]/

/** 解析出的系统事件（判别联合，后续扩展加新 kind） */
export type SystemEvent
    = { kind: 'group_renamed', newName: string }

/**
 * 尝试性解析系统消息。非系统消息 / 无法识别的系统消息一律返回 null（调用方据此跳过、不做副作用）。
 */
export function parseSystemEvent(msg: WeflowMessage): SystemEvent | null {
    if (msg.localType !== SYSTEM_LOCAL_TYPE) return null
    const content = typeof msg.content === 'string' ? msg.content : ''

    const rename = GROUP_RENAME_RE.exec(content)
    if (rename) {
        const newName = rename[1].trim()
        if (newName) return { kind: 'group_renamed', newName }
    }

    return null
}
