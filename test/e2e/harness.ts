import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const APP_ID = '100000000000000001';
export const GUILD = { id: '200000000000000002', name: 'Test Server', icon: null };
export const CHANNEL_ID = '300000000000000003';
export const ROLE_ID = '400000000000000004';
export const ADMIN = { email: 'reviewer@example.com', password: 'correct-horse-battery' };

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

// ---------------- Postgres (PGlite, real Postgres compiled to WASM) ----------------

export class TestDatabase {
  private db!: PGlite;
  private server: PGLiteSocketServer | null = null;
  port = 0;

  async start(): Promise<void> {
    // Note: on Windows PGlite's bundled initdb prints "The system cannot find the path specified." a few times. Harmless.
    this.db = await PGlite.create();
    // pglite-socket rejects the exclusive-lock promise when a client socket errors (e.g. the app process is
    // killed) but never handles that rejection. Attach a handler so a simulated crash doesn't fail the run.
    const runExclusive = this.db.runExclusive.bind(this.db);
    this.db.runExclusive = <T>(fn: () => Promise<T>) => {
      const p = runExclusive(fn);
      p.catch(() => undefined);
      return p;
    };
    this.port = await freePort();
    await this.listen();
  }
  async listen(): Promise<void> {
    this.server = new PGLiteSocketServer({ db: this.db, port: this.port, host: '127.0.0.1' });
    await this.server.start();
  }
  /** Simulates a database outage (connections refused) until `listen()` is called again. */
  async goDown(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }
  get url(): string {
    return `postgres://postgres:postgres@127.0.0.1:${this.port}/postgres`;
  }
  async stop(): Promise<void> {
    await this.server?.stop();
    await this.db.close();
  }
}

// ---------------- Mock Discord REST API + Slack webhook + Groq ----------------

export class MockUpstreams {
  private server!: http.Server;
  port = 0;
  edits: Array<{ token: string; body: any }> = [];
  channelPosts: Array<{ channelId: string; body: any; id: string }> = [];
  mirror: Array<any> = [];
  commandRegistrations = 0;
  failMirror = 0;
  failAi = 0;
  aiCalls = 0;
  private byNonce = new Map<string, string>();

  async start(): Promise<void> {
    this.port = await freePort();
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.route(req, res, raw));
    });
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', () => r()));
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const body = raw ? JSON.parse(raw.startsWith('{') || raw.startsWith('[') ? raw : '{}') : {};
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    let m: RegExpExecArray | null;

    if (req.method === 'POST' && p === '/api/v10/oauth2/token') return json(200, { access_token: 'user-token', guild: GUILD });
    if (req.method === 'GET' && p === `/api/v10/guilds/${GUILD.id}`) return json(200, GUILD);
    if (req.method === 'GET' && p === `/api/v10/guilds/${GUILD.id}/channels`) return json(200, [{ id: CHANNEL_ID, name: 'reports', type: 0, position: 1 }]);
    if (req.method === 'GET' && p === `/api/v10/guilds/${GUILD.id}/roles`)
      return json(200, [
        { id: GUILD.id, name: '@everyone', position: 0 },
        { id: ROLE_ID, name: 'mods', position: 1 },
      ]);
    if (req.method === 'PUT' && /^\/api\/v10\/applications\/\d+\/guilds\/\d+\/commands$/.test(p)) {
      this.commandRegistrations++;
      return json(200, body);
    }
    if (req.method === 'PATCH' && (m = /^\/api\/v10\/webhooks\/\d+\/([^/]+)\/messages\/@original$/.exec(p))) {
      this.edits.push({ token: m[1]!, body });
      return json(200, { id: 'orig' });
    }
    if (req.method === 'POST' && (m = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(p))) {
      const existing = body.nonce && this.byNonce.get(body.nonce);
      if (existing) return json(200, { id: existing });
      const id = String(500000000000000000n + BigInt(this.channelPosts.length));
      if (body.nonce) this.byNonce.set(body.nonce, id);
      this.channelPosts.push({ channelId: m[1]!, body, id });
      return json(200, { id });
    }
    if (req.method === 'POST' && p === '/services/slack-mirror') {
      if (this.failMirror > 0) {
        this.failMirror--;
        res.writeHead(503);
        return void res.end('upstream unavailable');
      }
      this.mirror.push(body);
      res.writeHead(200);
      return void res.end('ok');
    }
    if (req.method === 'POST' && p === '/openai/v1/chat/completions') {
      this.aiCalls++;
      if (this.failAi > 0) {
        this.failAi--;
        return json(500, { error: 'model overloaded' });
      }
      const text = String(body.messages?.[1]?.content ?? '');
      const critical = /checkout/i.test(text);
      return json(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: critical ? 'Checkout page fails for all users' : 'User feedback',
                category: critical ? 'incident' : 'feedback',
                severity: critical ? 'high' : 'low',
                tags: critical ? ['checkout', 'payments'] : ['misc'],
              }),
            },
          },
        ],
      });
    }
    json(404, { message: `mock: no route for ${req.method} ${p}` });
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

// ---------------- The app under test (spawned as a real process) ----------------

export const keys = generateKeyPairSync('ed25519');
export const publicKeyHex = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

export class TestApp {
  proc: ChildProcess | null = null;
  port = 0;
  logs = '';
  private spoolDir = mkdtempSync(join(tmpdir(), 'spool-'));

  constructor(
    private dbUrl: string,
    private upstreamPort: number,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (!this.port) this.port = await freePort();
    const up = `http://127.0.0.1:${this.upstreamPort}`;
    this.proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(this.port),
        LOG_LEVEL: 'info',
        PUBLIC_BASE_URL: this.url,
        DATABASE_URL: this.dbUrl,
        DATABASE_POOL_MAX: '1', // PGlite's socket server serves one connection at a time
        APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
        DISCORD_APPLICATION_ID: APP_ID,
        DISCORD_PUBLIC_KEY: publicKeyHex,
        DISCORD_BOT_TOKEN: 'e2e-bot-token-not-real',
        DISCORD_CLIENT_SECRET: 'e2e-client-secret',
        DISCORD_API_BASE: `${up}/api/v10`,
        GROQ_API_KEY: 'e2e-groq-key',
        GROQ_API_BASE: `${up}/openai/v1`,
        ADMIN_EMAIL: ADMIN.email,
        ADMIN_PASSWORD: ADMIN.password,
        KEEPALIVE: 'false',
        SPOOL_DIR: this.spoolDir,
        MIRROR_ALLOW_ANY_HOST: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout?.on('data', (d) => (this.logs += d));
    this.proc.stderr?.on('data', (d) => (this.logs += d));
    await waitFor(async () => (await fetch(`${this.url}/health/ready`)).ok, 'app to become ready', 60_000);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill();
    });
  }
}

// ---------------- Discord interaction helpers ----------------

let seq = 0n;
export function snowflake(): string {
  return String(((BigInt(Date.now()) - 1420070400000n) << 22n) + (seq++ % 4096n));
}

export interface SentInteraction {
  status: number;
  json: any;
}

export async function postSigned(appUrl: string, payload: object, opts: { timestamp?: string; key?: typeof keys.privateKey } = {}): Promise<SentInteraction> {
  const body = JSON.stringify(payload);
  const ts = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + body), opts.key ?? keys.privateKey).toString('hex');
  const res = await fetch(`${appUrl}/interactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export function interaction(type: number, data: object | undefined, opts: { userId?: string; permissions?: string; message?: object } = {}) {
  const id = snowflake();
  return {
    id,
    application_id: APP_ID,
    type,
    token: `tok_${id}_${randomBytes(8).toString('hex')}`,
    version: 1,
    guild_id: GUILD.id,
    channel_id: '600000000000000006',
    member: { user: { id: opts.userId ?? '700000000000000007', username: 'alice', global_name: 'Alice' }, permissions: opts.permissions ?? '0' },
    data,
    ...(opts.message ? { message: opts.message } : {}),
  };
}

export const slash = (name: string, text?: string, opts?: Parameters<typeof interaction>[2]) =>
  interaction(2, { id: '1', name, type: 1, options: text ? [{ name: 'text', type: 3, value: text }] : [] }, opts);

// ---------------- Dashboard session helpers ----------------

export class Browser {
  cookie = '';
  constructor(private base: string) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: this.cookie } });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }

  async form(path: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  }

  async csrf(path: string): Promise<string> {
    const html = await (await this.fetch(path)).text();
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!m) throw new Error(`no csrf token on ${path}`);
    return m[1]!;
  }
}
