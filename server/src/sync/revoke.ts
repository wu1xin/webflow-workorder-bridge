// 撤回检测与撤回窗口判定（纯函数，便于单测）。
// 背景见 docs/plans/2026-06-29-weflow-撤回检测-design.md。
//
// 关键事实：
//   - 撤回是「原地改写」——同 serverId 的那行 localType 翻成 10000、content 变 revokemsg sysmsg。
//   - 撤回时限按类型分桶：普通消息 2min、文件消息 3h（文件判定见 mediaType.isFileMessage）。
import type { WeflowMessage } from '../weflow/restClient.js'
import { bodyText, isFileMessage } from '../weflow/mediaType.js'

/** 系统消息 localType（撤回行、群提示等恒为此未打包小整数） */
const SYSTEM_LOCAL_TYPE = 10000

/** 撤回时限（秒）：普通消息 2min */
const NORMAL_WINDOW_SEC = 2 * 60
/** 撤回时限（秒）：文件消息 3h */
const FILE_WINDOW_SEC = 3 * 60 * 60
/** 多留的宽限（秒）：防时钟偏移 / WeFlow 落库延迟，过点后再多盯一会 */
const REVOKE_GRACE_SEC = 30

/**
 * 近窗（秒）= 普通消息撤回窗口 + grace。对账扫描的「粗拉」覆盖此窗，能一网打尽普通消息撤回；
 * 仍在 3h 窗口、createTime 早于近窗的文件消息，则改用定向探针。
 */
export const NEAR_REVOKE_WINDOW_SEC = NORMAL_WINDOW_SEC + REVOKE_GRACE_SEC

/** 撤回行：<sysmsg type="revokemsg"> */
const REVOKE_RE = /<sysmsg[^>]*type=["']revokemsg/

/**
 * 是否撤回行：localType 恒为系统消息小整数 10000，且原文命中 revokemsg sysmsg。
 * 该行的 serverId 即被撤消息 id（原地改写）。
 */
export function isRevokeRow(msg: WeflowMessage): boolean {
    return msg.localType === SYSTEM_LOCAL_TYPE && REVOKE_RE.test(bodyText(msg))
}

/**
 * 算撤回截止时间（秒）：createTime + 窗口(按类型) + grace。
 * 系统消息 / 缺 createTime / 当下已过窗口 → 返回 null（不进对账扫描）。
 */
export function computeRevocableUntil(msg: WeflowMessage, now: number): number | null {
    if (msg.localType === SYSTEM_LOCAL_TYPE) return null
    if (typeof msg.createTime !== 'number') return null
    const window = isFileMessage(msg) ? FILE_WINDOW_SEC : NORMAL_WINDOW_SEC
    const deadline = msg.createTime + window + REVOKE_GRACE_SEC
    return deadline > now ? deadline : null
}
