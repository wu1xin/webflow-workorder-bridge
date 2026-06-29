// WeFlow 消息媒体语义分类（纯函数，便于单测）。
//
// 关键事实：媒体「是不是」必须看 localType，不能看 media* 字段——
//   media* 字段只在 WeFlow 把文件下载进本地缓存后才出现，是异步最终一致的，会漏判未缓存的媒体。
//   localType 是打包整数：低 32 位=基础类型，高 32 位=appmsg 子类型；文件 = (6<<32)|49。
import type { WeflowMessage } from './restClient.js'
import type { MediaType } from '../upstream/types.js'

/** appmsg 基础类型（localType 低 32 位） */
const APPMSG_BASE_TYPE = 49
/** appmsg 文件子类型（localType 高 32 位 / XML 内 <type>） */
const FILE_APP_TYPE = 6
/** 32 位进位，用于拆分打包的 localType */
const U32 = 2 ** 32
/** 文件附件：appmsg 里带 <appattach>…<fileext> */
const FILE_ATTACH_RE = /<appattach>[\s\S]*?<fileext>/

/** 取消息原文（rawContent 优先，回退 content）用于正则识别 */
export function bodyText(msg: WeflowMessage): string {
    return `${msg.rawContent ?? ''}\n${msg.content ?? ''}`
}

/** 拆打包 localType：低 32 位=基础类型(base)，高 32 位=appmsg 子类型(sub) */
export function unpackLocalType(lt: number): { base: number, sub: number } {
    return { base: lt % U32, sub: Math.floor(lt / U32) }
}

/**
 * 是否文件消息（享 3h 撤回窗口）。双保险：
 *   1) localType 低 32 位=49(appmsg)、高 32 位=6(文件子类型)；
 *   2) 原文里带 <appattach>…<fileext>。
 * 链接 appmsg(type 5)、引用(type 57) 等不算。
 */
export function isFileMessage(msg: WeflowMessage): boolean {
    const lt = msg.localType
    if (typeof lt !== 'number') return false
    const { base, sub } = unpackLocalType(lt)
    if (base !== APPMSG_BASE_TYPE || sub !== FILE_APP_TYPE) return false
    return FILE_ATTACH_RE.test(bodyText(msg))
}

/**
 * 媒体语义分类；非媒体返回 null。只认 localType（文件再加 appattach 双保险）。
 * 不看 media* 字段，故对未缓存的媒体也能即时正确判定。
 */
export function classifyMedia(msg: WeflowMessage): MediaType | null {
    const lt = msg.localType
    if (typeof lt !== 'number') return null
    if (isFileMessage(msg)) return 'file'
    // 非文件 appmsg（链接/引用/聊天记录等）base=49 落到 default → null
    switch (unpackLocalType(lt).base) {
        case 3: return 'image'
        case 34: return 'voice'
        case 43: return 'video'
        case 47: return 'emoji'
        default: return null
    }
}
