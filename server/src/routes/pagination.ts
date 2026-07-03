// 分页公共件：正整数解析 + 页大小上下限。messages.ts / dlq.ts 共用，保证「非法即 400」口径一致。
export const PAGE_SIZE_MAX = 100
export const PAGE_SIZE_DEFAULT = 20

/** 解析正整数；非法（含 NaN、非整数、<=0、undefined）返回 null */
export function parsePositiveInt(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
}
