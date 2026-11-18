/**
 * Minimal Notion API client (version pinned to 2026-03-11).
 *
 * Retry rules (developers.notion.com/reference/request-limits, verified 2026-11-12):
 *  - 429 rate_limited and 529 service_overload: always retried, honouring Retry-After (seconds),
 *    except 429 with rate_limit_reason "public_api_request_blocked".
 *  - 500/502/503/504: retried only for reads and idempotent writes (setting a property to an
 *    absolute value). Non-idempotent requests (create database) are never retried on 5xx or
 *    network errors, because the request may already have taken effect.
 *  - Other 4xx: never retried.
 * All requests pass through a shared token bucket (default 2.5 req/s).
 */
import type { Logger } from "pino";
import { getLogger } from "../logger";
import { TokenBucket, realTime, type TimeSource } from "./rate-limiter";
import { NOTION_API_VERSION, type Database, type DataSource, type NotionErrorBody, type Page, type QueryResponse } from "./types";

export type RetryClass = "read" | "idempotent_write" | "non_idempotent";

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly attempts: number,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
  get isAuthError() {
    return this.status === 401 || this.code === "unauthorized";
  }
  get isNotFound() {
    return this.status === 404;
  }
}

/** Transport failed after the request may have reached Notion (non-idempotent call). */
export class NotionUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionUncertainError";
  }
}

export type NotionClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  time?: TimeSource;
  limiter?: TokenBucket;
  ratePerSec?: number;
  maxAttempts?: number;
  /** Retry-After longer than this aborts with a retryable error instead of blocking. */
  maxRetryAfterMs?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  random?: () => number;
};

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

export class NotionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly time: TimeSource;
  readonly limiter: TokenBucket;
  private readonly maxAttempts: number;
  private readonly maxRetryAfterMs: number;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly random: () => number;
  /** Simple counters for sync-run reporting. */
  readonly stats = { requests: 0, retries: 0, rateLimited: 0 };

  constructor(private readonly opts: NotionClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.time = opts.time ?? realTime;
    // Burst 1: never more than ~3 requests in any one-second window (Notion: avg 3 req/s).
    this.limiter = opts.limiter ?? new TokenBucket(opts.ratePerSec ?? 2.5, 1, this.time);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.log = opts.logger ?? getLogger().child({ component: "notion-client" });
    this.random = opts.random ?? Math.random;
  }

  retrieveDatabase(databaseId: string): Promise<Database> {
    return this.request("GET", `/v1/databases/${encodeURIComponent(databaseId)}`, undefined, "read");
  }

  retrieveDataSource(dataSourceId: string): Promise<DataSource> {
    return this.request("GET", `/v1/data_sources/${encodeURIComponent(dataSourceId)}`, undefined, "read");
  }

  queryDataSource(
    dataSourceId: string,
    body: { filter?: unknown; sorts?: unknown; start_cursor?: string; page_size?: number },
  ): Promise<QueryResponse> {
    // A query is a read even though it uses POST.
    return this.request("POST", `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, body, "read");
  }

  /** Sets property values to absolute values — safe to retry (same result if applied twice). */
  updatePageProperties(pageId: string, properties: Record<string, unknown>): Promise<Page> {
    return this.request("PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, { properties }, "idempotent_write");
  }

  createDatabase(body: Record<string, unknown>): Promise<Database> {
    return this.request("POST", "/v1/databases", body, "non_idempotent");
  }

  /** M8: create a page in a data source. Non-idempotent: never retried automatically (a retry could duplicate it). */
  createPage(body: { parent: { type: "data_source_id"; data_source_id: string }; properties: Record<string, unknown> }): Promise<Page> {
    return this.request("POST", "/v1/pages", body, "non_idempotent");
  }

  private backoffMs(attempt: number) {
    return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(this.random() * 250);
  }

  async request<T>(method: string, path: string, body: unknown, retryClass: RetryClass): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    for (let attempt = 1; ; attempt++) {
      await this.limiter.acquire();
      this.stats.requests++;
      const started = this.time.now();
      let res: Response;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        try {
          res = await this.fetchImpl(url, {
            method,
            headers: {
              Authorization: `Bearer ${this.opts.token}`,
              "Notion-Version": NOTION_API_VERSION,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn({ method, path, attempt, err: msg }, "notion request transport error");
        if (retryClass === "non_idempotent") {
          throw new NotionUncertainError(`Notion ${method} ${path} failed after sending; outcome unknown (${msg})`);
        }
        if (attempt >= this.maxAttempts) throw new NotionApiError(0, "network_error", msg, attempt);
        this.stats.retries++;
        await this.time.sleep(this.backoffMs(attempt));
        continue;
      }

      if (res.ok) {
        this.log.debug({ method, path, status: res.status, attempt, ms: this.time.now() - started }, "notion request ok");
        return (await res.json()) as T;
      }

      const errBody = (await res.json().catch(() => null)) as NotionErrorBody | null;
      const code = errBody?.code ?? `http_${res.status}`;
      const message = errBody?.message ?? res.statusText;
      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : undefined;
      const blocked = (errBody?.additional_data as { rate_limit_reason?: string } | undefined)?.rate_limit_reason === "public_api_request_blocked";

      const isRateLimit = (res.status === 429 && !blocked) || res.status === 529;
      const retryable = isRateLimit || (RETRYABLE_5XX.has(res.status) && retryClass !== "non_idempotent");
      this.log.warn({ method, path, status: res.status, code, attempt, retryable, retry_after_ms: retryAfterMs }, "notion request failed");

      if (!retryable || attempt >= this.maxAttempts) {
        throw new NotionApiError(res.status, code, message, attempt, errBody?.request_id, retryAfterMs);
      }
      if (isRateLimit) {
        this.stats.rateLimited++;
        this.limiter.penalize();
      }
      const wait = retryAfterMs ?? this.backoffMs(attempt);
      if (wait > this.maxRetryAfterMs) {
        throw new NotionApiError(res.status, code, `${message} (Retry-After ${wait} ms exceeds limit)`, attempt, errBody?.request_id, wait);
      }
      this.stats.retries++;
      await this.time.sleep(wait);
    }
  }
}
