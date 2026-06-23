// 轻量 fetch 封装：统一前缀、JSON 收发、错误归一化。
// 开发期经 Vite 代理 /api → localhost:8787；生产期同源。

/** 接口统一前缀；EventSource 等非 fetch 调用也复用它拼地址 */
export const BASE = '/api'

/** 接口错误：携带 HTTP 状态码与后端返回体 */
export class ApiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly body?: unknown,
    ) {
        super(message)
        this.name = 'ApiError'
    }
}

function safeParse(text: string): unknown {
    if (!text) return undefined
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
        res = await fetch(`${BASE}${path}`, {
            method,
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        })
    } catch (e) {
    // 网络层失败（后端未启动 / 不可达）
        throw new ApiError(0, e instanceof Error ? e.message : '网络请求失败')
    }

    const data = safeParse(await res.text())
    if (!res.ok) {
        const msg =
            data && typeof data === 'object' && 'error' in data
                ? String((data as Record<string, unknown>).error)
                : `请求失败（HTTP ${res.status}）`
        throw new ApiError(res.status, msg, data)
    }
    return data as T
}

export const httpGet = <T>(path: string): Promise<T> => request<T>('GET', path)
export const httpPut = <T>(path: string, body: unknown): Promise<T> => request<T>('PUT', path, body)
export const httpPost = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body)
