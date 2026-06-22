// 敏感字段加密：AES-256-GCM + 机器绑定 keyfile（无主密码，满足开机无人值守自启同时不明文落盘）。
// 见 docs/config/weflow-配置说明.md §7。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { appDataDir, keyFilePath } from './paths.js'

/** AES-256-GCM 加密信封（落盘形态，各字段 base64） */
export interface EncryptedEnvelope {
    /** 算法标识，固定 'aes-256-gcm' */
    enc: 'aes-256-gcm'
    /** 初始化向量（12 字节 GCM nonce），base64 */
    iv: string
    /** 认证标签（16 字节），base64 */
    tag: string
    /** 密文，base64 */
    data: string
}

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

let cachedKey: Buffer | null = null

/**
 * 读取（首次运行则生成）机器绑定主密钥。
 * keyfile 权限收紧到仅属主可读写（POSIX 0o600；Windows 上 chmod 能力有限，尽力而为）。
 */
function loadOrCreateKey(): Buffer {
    if (cachedKey) return cachedKey
    const file = keyFilePath()
    if (existsSync(file)) {
        const key = readFileSync(file)
        if (key.length !== KEY_BYTES) {
            throw new Error(`keyfile 长度异常（期望 ${KEY_BYTES} 字节，实际 ${key.length}）：${file}`)
        }
        cachedKey = key
        return key
    }
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, key, { mode: 0o600 })
    try {
        chmodSync(file, 0o600)
    } catch {
        // Windows 下 chmod 可能不完全生效，忽略
    }
    cachedKey = key
    return key
}

/** 确保应用数据目录存在 */
export function ensureAppDataDir(): void {
    mkdirSync(appDataDir(), { recursive: true })
}

/** 判断一个值是否为加密信封（用于落盘配置解析） */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
    return (
        typeof value === 'object'
        && value !== null
        && (value as Record<string, unknown>).enc === ALGORITHM
        && typeof (value as Record<string, unknown>).iv === 'string'
        && typeof (value as Record<string, unknown>).tag === 'string'
        && typeof (value as Record<string, unknown>).data === 'string'
    )
}

/** 用机器绑定密钥加密明文，返回落盘信封 */
export function encrypt(plaintext: string): EncryptedEnvelope {
    const key = loadOrCreateKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
        enc: ALGORITHM,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
    }
}

/** 解密落盘信封，返回明文 */
export function decrypt(envelope: EncryptedEnvelope): string {
    const key = loadOrCreateKey()
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const data = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
    ])
    return data.toString('utf8')
}
