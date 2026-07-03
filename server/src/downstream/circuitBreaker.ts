// 轻量熔断器：只统计「下游不可用」类连续失败；达阈值打开，冷却期后半开放行一条探测。
// 时钟注入便于测试；时间单位秒。
export type CircuitState = 'closed' | 'open' | 'half-open'

export class CircuitBreaker {
    private consecutive = 0
    private openedAt: number | null = null

    constructor(
        private readonly threshold: number,
        private readonly cooldownSec: number,
        private readonly now: () => number,
    ) {}

    recordSuccess(): void {
        this.consecutive = 0
        this.openedAt = null
    }

    recordFailure(): void {
        this.consecutive += 1
        if (this.consecutive >= this.threshold) this.openedAt = this.now()
    }

    /** 是否处于熔断（阻断取件）。冷却到点后返回 false（半开：放行一条探测） */
    isOpen(): boolean {
        if (this.openedAt === null) return false
        return this.now() - this.openedAt < this.cooldownSec
    }

    state(): CircuitState {
        if (this.openedAt === null) return 'closed'
        return this.isOpen() ? 'open' : 'half-open'
    }
}
