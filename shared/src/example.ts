/** 案例 */
export const Example = {
    /** 类型 */
    type: 'type',
    /** 变量 */
    constant: 'constant',
    /** 函数 */
    util: 'util',
} as const
/** 案例 */
export type Example = (typeof Example)[keyof typeof Example]
