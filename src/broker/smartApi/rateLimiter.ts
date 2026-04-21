import { env } from "../../config/env.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class SmartApiRateLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private nextAllowedAtMs = 0;
  private cooldownUntilMs = 0;

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.waitForTurn();
      return await fn();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  noteRateLimit(attempt: number, status: number): void {
    const base = Math.max(1, env.angelHttpRateLimitCooldownMs);
    const max = Math.max(base, env.angelHttpMaxBackoffMs);
    const cooldown = Math.min(max, base * 2 ** attempt);
    const until = Date.now() + cooldown;
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, until);
    if (env.angelHttpLogLimiter) {
      const q = this.queue.length;
      console.warn(
        `[AngelLimiter] status=${status} attempt=${attempt + 1} cooldown=${cooldown}ms queue=${q}`
      );
    }
  }

  private async acquireSlot(): Promise<void> {
    const maxConcurrency = Math.max(1, env.angelHttpMaxConcurrency);
    if (this.active < maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private async waitForTurn(): Promise<void> {
    const gap = Math.max(0, env.angelHttpMinGapMs);
    while (true) {
      const now = Date.now();
      const wait = Math.max(this.nextAllowedAtMs, this.cooldownUntilMs) - now;
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.nextAllowedAtMs = Date.now() + gap;
  }

  private drain(): void {
    const maxConcurrency = Math.max(1, env.angelHttpMaxConcurrency);
    while (this.active < maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) continue;
      next();
    }
  }
}

const limiter = new SmartApiRateLimiter();

export function scheduleSmartApiCall<T>(fn: () => Promise<T>): Promise<T> {
  return limiter.schedule(fn);
}

export function noteSmartApiRateLimit(attempt: number, status: number): void {
  limiter.noteRateLimit(attempt, status);
}

export function retryJitterMs(): number {
  const max = Math.max(0, env.angelHttpRetryJitterMs);
  if (max <= 0) return 0;
  return Math.floor(Math.random() * (max + 1));
}
