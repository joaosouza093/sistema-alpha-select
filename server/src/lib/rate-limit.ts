import { tooMany } from './errors.js';

/**
 * Limitador em memória por chave (janela deslizante simples).
 * Adequado para uma instância. Com múltiplas instâncias, substituir por
 * armazenamento compartilhado (ver docs/SEGURANCA.md).
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Registra uma tentativa; lança 429 quando o limite é excedido. */
  consume(key: string): void {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      throw tooMany();
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.sweep(now);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) {
      if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

export interface Limiters {
  loginIp: RateLimiter;
  loginAccount: RateLimiter;
  resetIp: RateLimiter;
  resetAccount: RateLimiter;
  tokenIp: RateLimiter;
  upload: RateLimiter;
  invite: RateLimiter;
}

export function createLimiters(): Limiters {
  const min = 60_000;
  return {
    loginIp: new RateLimiter(30, 15 * min),
    loginAccount: new RateLimiter(8, 15 * min),
    resetIp: new RateLimiter(10, 60 * min),
    resetAccount: new RateLimiter(3, 60 * min),
    tokenIp: new RateLimiter(20, 15 * min),
    upload: new RateLimiter(40, 10 * min),
    invite: new RateLimiter(30, 60 * min),
  };
}
