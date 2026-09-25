import { errorMessage } from './redact.js';

/**
 * Error classification drives the job queue: retryable errors are rescheduled with backoff,
 * permanent ones go straight to the dead-letter state where the dashboard surfaces them.
 */
export class JobError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class HttpError extends JobError {
  constructor(
    readonly status: number,
    message: string,
    retryAfterMs?: number,
  ) {
    // 408/425/429/5xx are transient; other 4xx mean the request itself is wrong.
    super(message, status === 408 || status === 425 || status === 429 || status >= 500, retryAfterMs);
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Short label used in error messages instead of the (possibly secret) URL. */
  label: string;
}

export async function request<T = unknown>(url: string, opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { 'user-agent': 'DiscordReportBot (https://github.com, 1.0)', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (err) {
    // Network failure / DNS / timeout: always worth retrying.
    throw new JobError(`${opts.label}: network error: ${errorMessage(err)}`, true);
  }

  const text = await res.text();
  if (!res.ok) {
    let retryAfterMs: number | undefined;
    const header = res.headers.get('retry-after');
    if (header && !Number.isNaN(Number(header))) retryAfterMs = Number(header) * 1000;
    try {
      const parsed = JSON.parse(text) as { retry_after?: number };
      if (typeof parsed.retry_after === 'number') retryAfterMs = parsed.retry_after * 1000;
    } catch {
      /* body is not JSON */
    }
    throw new HttpError(res.status, `${opts.label}: HTTP ${res.status} ${errorMessage(text.slice(0, 300))}`, retryAfterMs);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** A shared time budget for work that must finish inside Discord's 3-second response window. */
export class Deadline {
  private readonly end: number;
  constructor(totalMs: number) {
    this.end = Date.now() + totalMs;
  }
  remaining(): number {
    return Math.max(0, this.end - Date.now());
  }
  /** The smaller of `ms` and whatever is left of the budget. */
  cap(ms: number): number {
    return Math.min(ms, this.remaining());
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
