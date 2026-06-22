// 连接层统一用 Fastify 自带的 pino logger（app.log）。
// 这里只做类型别名，避免各模块直接耦合 fastify 类型，也便于将来替换实现。
import type { FastifyBaseLogger } from 'fastify'

export type Logger = FastifyBaseLogger
