// 媒体源解析：转发时按类型把一条 WeFlow 媒体消息定位到本地可读文件（本地 fs，同机部署）。
//   图/语/表情：读 WeFlow 缓存字段 mediaLocalPath；
//   文件：读微信 xwechat_files 目录 <fileBaseDir>/YYYY-MM/<title>，用 size==totallen 判完整落盘；
//   视频/非媒体：unsupported（forwarder 降级发纯文本占位）。
// 见 docs/plans/2026-07-09-下游媒体上传对接-design.md §4/§5。
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WeflowMessage } from '../weflow/restClient.js'
import type { MediaType } from '../upstream/types.js'
import { classifyMedia } from '../weflow/mediaType.js'

/** 媒体源解析结果 */
export type MediaSource =
  | { status: 'ready', absPath: string, fileName: string, mediaType: MediaType } // 本地文件就绪，可读字节上传
  | { status: 'waiting', mediaType: MediaType }                                  // 未缓存/未落盘/未完整，稍后重试
  | { status: 'unsupported' }                                                    // 视频/非媒体，无从取字节

/** 把 createTime（秒）按本地时区折成文件目录月份 YYYY-MM */
export function fileMonthFolder(createTimeSec: number): string {
    const d = new Date(createTimeSec * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 从文件 appmsg 的 rawContent 解析 <title>（文件名，含扩展名）与 <totallen>（最终字节数） */
function parseFileMeta(raw: string): { title: string | null, totalLen: number | null } {
    const title = /<title>([\s\S]*?)<\/title>/.exec(raw)?.[1]?.trim() || null
    const lenStr = /<totallen>(\d+)<\/totallen>/.exec(raw)?.[1]
    return { title, totalLen: lenStr ? Number(lenStr) : null }
}

/** 文件是否已完整落盘：有 totalLen 则精确匹配字节数，无则退化为 size>0 */
function isComplete(absPath: string, totalLen: number | null): boolean {
    if (!existsSync(absPath)) return false
    const size = statSync(absPath).size
    return totalLen !== null ? size === totalLen : size > 0
}

/** 文件消息候选月份目录：当月 + 上月（容忍月份边界/按下载日期归档的偏差） */
function monthsToScan(createTimeSec: number): string[] {
    const cur = fileMonthFolder(createTimeSec)
    const d = new Date(createTimeSec * 1000)
    const prevD = new Date(d.getFullYear(), d.getMonth() - 1, 1) // Date 自动规整跨年
    const prev = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, '0')}`
    return [cur, prev]
}

function resolveFile(msg: WeflowMessage, fileBaseDir: string): MediaSource {
    const { title, totalLen } = parseFileMeta(msg.rawContent ?? '')
    if (!title || typeof msg.createTime !== 'number') return { status: 'unsupported' }
    for (const m of monthsToScan(msg.createTime)) {
        const abs = join(fileBaseDir, m, title)
        if (isComplete(abs, totalLen)) return { status: 'ready', absPath: abs, fileName: title, mediaType: 'file' }
    }
    return { status: 'waiting', mediaType: 'file' }
}

/**
 * 定位一条媒体消息的本地文件。非媒体/视频 → unsupported；未就绪 → waiting；就绪 → ready + 绝对路径。
 * @param opts.fileBaseDir 文件类媒体根目录（未配置则文件类一律 unsupported）
 */
export function resolveMediaSource(msg: WeflowMessage, opts: { fileBaseDir?: string }): MediaSource {
    const mediaType = classifyMedia(msg)
    if (mediaType === null || mediaType === 'video') return { status: 'unsupported' }

    if (mediaType === 'file') {
        return opts.fileBaseDir ? resolveFile(msg, opts.fileBaseDir) : { status: 'unsupported' }
    }

    // image / voice / emoji：WeFlow 主动下载到缓存，读 mediaLocalPath
    const p = msg.mediaLocalPath
    if (!p || !existsSync(p) || statSync(p).size <= 0) return { status: 'waiting', mediaType }
    return { status: 'ready', absPath: p, fileName: msg.mediaFileName ?? basename(p), mediaType }
}
