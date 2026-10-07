/**
 * Proxy gateway building blocks for the phone farm.
 *
 * Every phone talks to ONE place only: `127.0.0.1:8888` on the phone, which `adb reverse`
 * maps to a per-device {@link DeviceProxyListener} on the farm PC. The listener decides per
 * connection where traffic goes ({@link RouteDecision}): through the device's upstream proxy,
 * directly from the PC, or nowhere (blocked). That gives us, independent of what the phone
 * supports:
 *   - username/password auth (Android's global proxy has no credentials field);
 *   - HTTP *and* SOCKS5 upstreams (Android's global proxy is HTTP-only) with auto-detection;
 *   - a per-upstream concurrent-connection cap (shared mobile proxies often allow ~50 sockets);
 *   - instant switching of the shared proxy between phones without touching ADB.
 *
 * Zero external dependencies: native `net`, `http`, `https`, `tls`.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Logger } from 'pino';

export type ProxyType = 'http' | 'https' | 'socks5' | 'residential' | 'mobile';
export type UpstreamProtocol = 'http' | 'socks5';

export interface UpstreamProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Declared type. Only a hint — the real protocol is probed (see {@link UpstreamProxy.resolveProtocol}). */
  type?: ProxyType;
}

export type ProxyErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'auth_failed'
  | 'rejected'
  | 'target_failed'
  | 'protocol'
  | 'busy';

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly code: ProxyErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProxyError';
  }

  /** Transient failures worth another attempt (rate-limit bursts, resets, flaky mobile modems). */
  get retryable(): boolean {
    if (this.code === 'timeout' || this.code === 'unreachable') return true;
    if (this.code === 'rejected') {
      return this.status === undefined || [403, 429, 500, 502, 503, 504].includes(this.status);
    }
    return false;
  }
}

export function toProxyError(err: unknown): ProxyError {
  if (err instanceof ProxyError) return err;
  return new ProxyError(err instanceof Error ? err.message : String(err), 'unreachable');
}

/** `mobile` / `residential` describe where the IP comes from, not the wire protocol. */
export function declaredProtocol(type?: ProxyType): UpstreamProtocol | undefined {
  if (type === 'socks5') return 'socks5';
  if (type === 'http' || type === 'https') return 'http';
  return undefined;
}

/** Identity of an upstream proxy: same server + same credentials share one connection pool. */
export function upstreamKey(cfg: UpstreamProxyConfig): string {
  return [cfg.host.trim().toLowerCase(), cfg.port, cfg.username ?? '', cfg.password ?? ''].join('|');
}

/** Pull the first IPv4/IPv6 address out of a service response. */
export function extractIp(text: string): string | undefined {
  const v4 = text.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/);
  if (v4) return v4[0];
  for (const token of text.split(/\s+/)) {
    if (token.split(':').length >= 3 && net.isIPv6(token)) return token;
  }
  return undefined;
}

/** Parse `host:port`, `[v6]:port` or a bare host. */
export function parseHostPort(value: string, defaultPort: number): { host: string; port: number } | null {
  const v = value.trim();
  let host = v;
  let port = defaultPort;
  const bracketed = v.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if (!net.isIPv6(v)) {
    const idx = v.lastIndexOf(':');
    if (idx !== -1) {
      host = v.slice(0, idx);
      port = Number(v.slice(idx + 1));
    }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const noop = () => {};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SOCKS_REPLIES: Record<number, string> = {
  1: 'общая ошибка SOCKS-сервера',
  2: 'подключение запрещено правилами прокси',
  3: 'сеть недоступна',
  4: 'хост недоступен',
  5: 'соединение отклонено целевым сервером',
  6: 'истёк TTL',
  7: 'команда не поддерживается',
  8: 'тип адреса не поддерживается',
};

function httpStatusError(status: number, firstLine: string, target: string, label: string): ProxyError {
  if (status === 407) {
    return new ProxyError(`Прокси ${label} отклонил авторизацию (407) — проверьте логин и пароль`, 'auth_failed', status);
  }
  if (status === 403) {
    return new ProxyError(
      `Прокси ${label} запретил подключение к ${target} (403) — превышен лимит соединений, IP фермы не в белом списке или порт закрыт`,
      'rejected',
      status,
    );
  }
  if (status === 429) return new ProxyError(`Прокси ${label}: слишком много запросов (429)`, 'rejected', status);
  if (status >= 500) {
    return new ProxyError(`Прокси ${label} не смог подключиться к ${target} (${firstLine.trim()})`, 'rejected', status);
  }
  return new ProxyError(`Прокси ${label} ответил: ${firstLine.trim() || 'неизвестный ответ'}`, 'rejected', status || undefined);
}

function ipv6ToBuffer(addr: string): Buffer {
  const [head, tail] = addr.split('::');
  const parse = (s?: string) => (s ? s.split(':').filter(Boolean) : []);
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => buf.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return buf;
}

function socksAddress(host: string, port: number): Buffer {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const kind = net.isIP(host);
  if (kind === 4) return Buffer.concat([Buffer.from([0x01, ...host.split('.').map(Number)]), portBuf]);
  if (kind === 6) return Buffer.concat([Buffer.from([0x04]), ipv6ToBuffer(host), portBuf]);
  const dom = Buffer.from(host);
  return Buffer.concat([Buffer.from([0x03, dom.length]), dom, portBuf]);
}

// ── Connection limiter ──────────────────────────────────────────────────────

class ConnectionLimiter {
  private active = 0;
  private waiters: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(timeoutMs: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.waiters.shift();
          if (next) {
            clearTimeout(next.timer);
            next.grant();
          }
        });
      };
      if (this.max <= 0 || this.active < this.max) {
        grant();
        return;
      }
      const waiter = {
        grant,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new ProxyError(`Достигнут лимит ${this.max} одновременных соединений через прокси`, 'busy'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

// ── Upstream proxy ──────────────────────────────────────────────────────────

export interface UpstreamTestResult {
  ok: boolean;
  protocol?: UpstreamProtocol;
  ip?: string;
  latencyMs: number;
  error?: string;
  code?: ProxyErrorCode;
}

export interface UpstreamOptions {
  maxConnections: number;
  connectTimeoutMs?: number;
  queueTimeoutMs?: number;
  /**
   * Reach the upstream proxy through this HTTP CONNECT relay (`http://host:port`), e.g. the
   * production server over AmneziaWG, so the farm ISP's DPI can't see/block the destinations.
   */
  via?: string;
}

/**
 * Open a TCP connection to `host:port`, optionally through an HTTP CONNECT relay.
 * Resolves with the connected socket (relay handshake already done).
 */
function openTcp(host: string, port: number, via: { host: string; port: number } | undefined, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(via ? { host: via.host, port: via.port } : { host, port });
    sock.setNoDelay(true);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
      if (err) {
        sock.on('error', noop);
        sock.destroy();
        reject(err);
      } else {
        resolve(sock);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          via
            ? new ProxyError(`Relay ${via.host}:${via.port} не ответил (туннель AmneziaWG поднят?)`, 'timeout')
            : new ProxyError(`Прокси ${host}:${port} не отвечает (таймаут подключения)`, 'timeout'),
        ),
      timeoutMs,
    );
    const onError = (err: Error) =>
      finish(
        new ProxyError(
          via
            ? `Нет соединения с relay ${via.host}:${via.port}: ${err.message}`
            : `Нет соединения с прокси ${host}:${port}: ${err.message}`,
          'unreachable',
        ),
      );
    const onClose = () => finish(new ProxyError(`Relay закрыл соединение к ${host}:${port}`, 'unreachable'));
    sock.on('error', onError);
    sock.on('close', onClose);
    sock.once('connect', () => {
      if (!via) return finish();
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        sock.removeListener('data', onData);
        const firstLine = buf.subarray(0, end).toString('latin1').split('\r\n')[0];
        if (!/^HTTP\/\d(?:\.\d)?\s+200/.test(firstLine)) {
          const body = buf.subarray(end + 4).toString('utf-8').trim();
          finish(new ProxyError(`Relay не смог подключиться к прокси ${host}:${port}: ${body || firstLine}`, 'unreachable'));
          return;
        }
        sock.pause();
        const rest = buf.subarray(end + 4);
        if (rest.length) sock.unshift(rest);
        finish();
      };
      sock.on('data', onData);
    });
  });
}

function parseVia(via?: string): { host: string; port: number } | undefined {
  if (!via) return undefined;
  const u = new URL(via.includes('://') ? via : `http://${via}`);
  return { host: u.hostname, port: Number(u.port) || 3129 };
}

const IP_ECHO_ENDPOINTS = [
  { host: 'api.ipify.org', path: '/' },
  { host: 'ifconfig.me', path: '/ip' },
  { host: 'icanhazip.com', path: '/' },
];

export class UpstreamProxy {
  readonly key: string;
  private protocol: UpstreamProtocol | null = null;
  private probing: Promise<UpstreamProtocol> | null = null;
  private readonly limiter: ConnectionLimiter;
  private readonly connectTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private readonly via?: { host: string; port: number };
  lastError?: string;
  lastErrorAt?: number;

  constructor(
    readonly config: UpstreamProxyConfig,
    private readonly logger: Logger,
    opts: UpstreamOptions,
  ) {
    this.key = upstreamKey(config);
    this.limiter = new ConnectionLimiter(opts.maxConnections);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 12_000;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 20_000;
    this.via = parseVia(opts.via);
  }

  get label(): string {
    return `${this.config.host}:${this.config.port}${this.via ? ` (через relay ${this.via.host})` : ''}`;
  }

  get detectedProtocol(): UpstreamProtocol | null {
    return this.protocol;
  }

  get activeConnections(): number {
    return this.limiter.inUse;
  }

  get queuedConnections(): number {
    return this.limiter.queued;
  }

  authHeader(): string | undefined {
    if (!this.config.username) return undefined;
    const creds = Buffer.from(`${this.config.username}:${this.config.password ?? ''}`).toString('base64');
    return `Basic ${creds}`;
  }

  /** Raw TCP connection to the proxy itself (through the relay if configured), for absolute-URI HTTP. */
  connectRaw(): Promise<net.Socket> {
    return openTcp(this.config.host, this.config.port, this.via, this.connectTimeoutMs).then((sock) => {
      sock.on('error', noop);
      return sock;
    });
  }

  /** Reserve a slot for a plain-HTTP request forwarded in absolute-URI form. */
  acquireSlot(): Promise<() => void> {
    return this.limiter.acquire(this.queueTimeoutMs);
  }

  /** Detect whether the upstream speaks SOCKS5 or HTTP (cached). */
  async resolveProtocol(): Promise<UpstreamProtocol> {
    if (this.protocol) return this.protocol;
    if (!this.probing) {
      this.probing = this.probe()
        .then((p) => {
          this.protocol = p;
          return p;
        })
        .finally(() => {
          this.probing = null;
        });
    }
    return this.probing;
  }

  /**
   * Sends a SOCKS5 greeting: a SOCKS5 server answers `05 xx`, an HTTP proxy answers
   * `HTTP/1.x 400`. Silence or a closed socket falls back to the declared type.
   */
  private async probe(): Promise<UpstreamProtocol> {
    const fallback = declaredProtocol(this.config.type) ?? 'http';
    const sock = await openTcp(this.config.host, this.config.port, this.via, this.connectTimeoutMs);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (proto: UpstreamProtocol, detail: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(replyTimer);
        sock.on('error', noop);
        sock.destroy();
        this.logger.info({ upstream: this.label, protocol: proto, detail }, 'proxy: upstream protocol detected');
        resolve(proto);
      };
      const replyTimer = setTimeout(() => finish(fallback, 'no reply to SOCKS5 greeting'), 3_000);
      sock.on('error', () => finish(fallback, 'error after greeting'));
      sock.once('data', (chunk: Buffer) => {
        if (chunk[0] === 0x05) finish('socks5', `reply 0x${chunk.subarray(0, 2).toString('hex')}`);
        else if (chunk.toString('latin1', 0, 5) === 'HTTP/') finish('http', chunk.toString('latin1', 0, 20).trim());
        else finish(fallback, `unrecognised reply 0x${chunk.subarray(0, 4).toString('hex')}`);
      });
      sock.once('close', () => finish(fallback, 'closed without reply'));
      sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      sock.resume();
    });
  }

  /**
   * Open a raw TCP tunnel to `host:port` through the upstream. Retries transient failures
   * (403/5xx bursts, resets). The returned socket is paused; its slot is freed on close.
   */
  async openTunnel(host: string, port: number): Promise<net.Socket> {
    const release = await this.limiter.acquire(this.queueTimeoutMs);
    try {
      const protocol = await this.resolveProtocol();
      let lastErr: ProxyError | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const sock =
            protocol === 'socks5' ? await this.socks5Connect(host, port) : await this.httpConnect(host, port);
          sock.once('close', release);
          return sock;
        } catch (err) {
          lastErr = toProxyError(err);
          if (lastErr.code === 'protocol') this.protocol = null;
          if (!lastErr.retryable || attempt === 3) break;
          await delay(300 * attempt);
        }
      }
      const finalErr = lastErr ?? new ProxyError('Неизвестная ошибка прокси', 'unreachable');
      this.lastError = finalErr.message;
      this.lastErrorAt = Date.now();
      throw finalErr;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Connected socket to the upstream (through the relay if configured) + handshake helpers. */
  private async dial(): Promise<{ sock: net.Socket; fail: (e: ProxyError) => void; done: (rest: Buffer) => void; promise: Promise<net.Socket> }> {
    const sock = await openTcp(this.config.host, this.config.port, this.via, this.connectTimeoutMs);
    let resolveFn!: (s: net.Socket) => void;
    let rejectFn!: (e: ProxyError) => void;
    const promise = new Promise<net.Socket>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    let settled = false;
    const timer = setTimeout(
      () => fail(new ProxyError(`Прокси ${this.label} не ответил за ${Math.round(this.connectTimeoutMs / 1000)} с`, 'timeout')),
      this.connectTimeoutMs,
    );
    const onError = (err: Error) => fail(new ProxyError(`Нет соединения с прокси ${this.label}: ${err.message}`, 'unreachable'));
    const onClose = () => fail(new ProxyError(`Прокси ${this.label} закрыл соединение во время рукопожатия`, 'rejected'));
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
      sock.removeAllListeners('data');
    };
    const fail = (e: ProxyError) => {
      if (settled) return;
      settled = true;
      cleanup();
      sock.on('error', noop);
      sock.destroy();
      rejectFn(e);
    };
    const done = (rest: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Keep a listener forever: an unhandled 'error' on any socket would crash the agent.
      sock.on('error', noop);
      sock.pause();
      if (rest.length) sock.unshift(rest);
      resolveFn(sock);
    };
    sock.on('error', onError);
    sock.on('close', onClose);
    return { sock, fail, done, promise };
  }

  private async httpConnect(host: string, port: number): Promise<net.Socket> {
    const { sock, fail, done, promise } = await this.dial();
    const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const auth = this.authHeader();
    const request =
      `CONNECT ${target} HTTP/1.1\r\n` +
      `Host: ${target}\r\n` +
      (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
      `Proxy-Connection: Keep-Alive\r\n\r\n`;

    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let end = buf.indexOf('\r\n\r\n');
      let delimLen = 4;
      if (end === -1) {
        end = buf.indexOf('\n\n');
        delimLen = 2;
      }
      if (end === -1) {
        if (buf.length > 16_384) fail(new ProxyError(`Прокси ${this.label} прислал некорректный ответ`, 'protocol'));
        return;
      }
      const firstLine = buf.subarray(0, end).toString('latin1').split(/\r?\n/)[0] ?? '';
      const match = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
      if (!match) {
        fail(new ProxyError(`Прокси ${this.label} ответил не по HTTP: ${firstLine.slice(0, 60)}`, 'protocol'));
        return;
      }
      const status = Number(match[1]);
      if (status >= 200 && status < 300) done(buf.subarray(end + delimLen));
      else fail(httpStatusError(status, firstLine, target, this.label));
    });
    sock.write(request);
    sock.resume();
    return promise;
  }

  private async socks5Connect(host: string, port: number): Promise<net.Socket> {
    const { sock, fail, done, promise } = await this.dial();
    const connectRequest = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(host, port)]);
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
    let buf = Buffer.alloc(0);

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) {
            fail(new ProxyError(`Прокси ${this.label} не отвечает по протоколу SOCKS5`, 'protocol'));
            return;
          }
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0x00) {
            stage = 'connect';
            sock.write(connectRequest);
            continue;
          }
          if (method === 0x02) {
            const u = Buffer.from(this.config.username ?? '');
            const p = Buffer.from(this.config.password ?? '');
            if (!u.length || u.length > 255 || p.length > 255) {
              fail(new ProxyError(`SOCKS5-прокси ${this.label} требует логин и пароль`, 'auth_failed'));
              return;
            }
            stage = 'auth';
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            continue;
          }
          fail(new ProxyError(`SOCKS5-прокси ${this.label} не принял ни один способ авторизации`, 'auth_failed'));
          return;
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) {
            fail(new ProxyError(`SOCKS5-прокси ${this.label} отклонил логин/пароль`, 'auth_failed'));
            return;
          }
          buf = buf.subarray(2);
          stage = 'connect';
          sock.write(connectRequest);
          continue;
        }
        if (buf.length < 5) return;
        const rep = buf[1];
        if (rep !== 0x00) {
          const reason = SOCKS_REPLIES[rep] ?? `код ${rep}`;
          fail(new ProxyError(`SOCKS5 ${this.label}: ${reason} (${host}:${port})`, rep === 0x01 ? 'rejected' : 'target_failed'));
          return;
        }
        const atyp = buf[3];
        const len = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + buf[4] : -1;
        if (len < 0) {
          fail(new ProxyError(`SOCKS5 ${this.label}: некорректный ответ`, 'protocol'));
          return;
        }
        if (buf.length < len) return;
        done(buf.subarray(len));
        return;
      }
    });
    sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    sock.resume();
    return promise;
  }

  /** End-to-end check from the PC: HTTPS through the proxy to an IP-echo service. */
  async test(timeoutMs = 20_000): Promise<UpstreamTestResult> {
    const started = Date.now();
    let lastErr: ProxyError | undefined;
    try {
      await this.resolveProtocol();
    } catch (err) {
      const e = toProxyError(err);
      return { ok: false, error: e.message, code: e.code, latencyMs: Date.now() - started };
    }
    for (const endpoint of IP_ECHO_ENDPOINTS) {
      try {
        const raw = await this.openTunnel(endpoint.host, 443);
        const body = await httpsGetOverSocket(raw, endpoint.host, endpoint.path, timeoutMs);
        const ip = extractIp(body);
        if (!ip) throw new ProxyError(`Сервис ${endpoint.host} вернул неожиданный ответ: ${body.slice(0, 80)}`, 'target_failed');
        this.lastError = undefined;
        return { ok: true, protocol: this.protocol ?? undefined, ip, latencyMs: Date.now() - started };
      } catch (err) {
        lastErr = toProxyError(err);
        // Credentials / protocol problems won't get better with another endpoint.
        if (lastErr.code === 'auth_failed' || lastErr.code === 'unreachable' || lastErr.code === 'protocol') break;
      }
    }
    return {
      ok: false,
      protocol: this.protocol ?? undefined,
      error: lastErr?.message ?? 'Не удалось проверить прокси',
      code: lastErr?.code,
      latencyMs: Date.now() - started,
    };
  }
}

function httpsGetOverSocket(raw: net.Socket, host: string, path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'curl/8.4.0', Accept: 'text/plain' },
      createConnection: () => {
        const secure = tls.connect({ socket: raw, servername: host });
        secure.on('error', noop);
        raw.resume();
        return secure;
      },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new ProxyError(`Таймаут ответа от ${host} через прокси`, 'timeout')));
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (d: string) => {
        body += d;
      });
      res.on('end', () => {
        raw.destroy();
        if ((res.statusCode ?? 0) >= 400) {
          reject(new ProxyError(`${host} ответил ${res.statusCode} через прокси`, 'target_failed'));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', (err) => {
      raw.destroy();
      reject(err instanceof ProxyError ? err : new ProxyError(`TLS/HTTP ошибка через прокси (${host}): ${err.message}`, 'target_failed'));
    });
    req.end();
  });
}

function directConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new ProxyError(`Таймаут прямого подключения к ${host}:${port}`, 'timeout'));
    }, timeoutMs);
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(new ProxyError(`Прямое подключение к ${host}:${port} не удалось: ${err.message}`, 'target_failed'));
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.removeListener('error', onError);
      sock.on('error', noop);
      sock.setNoDelay(true);
      sock.pause();
      resolve(sock);
    });
  });
}

// ── Per-device listener ─────────────────────────────────────────────────────

export type RouteDecision =
  | { kind: 'proxy'; upstream: UpstreamProxy }
  | { kind: 'direct' }
  | { kind: 'block'; reason: string };

export interface ListenerStats {
  port: number;
  activeConnections: number;
  totalConnections: number;
  failedConnections: number;
  bytesUp: number;
  bytesDown: number;
  lastActivityAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface ListenerOptions {
  bindHost: string;
  idleTimeoutMs: number;
  directConnectTimeoutMs?: number;
}

const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/**
 * Unauthenticated local HTTP proxy for ONE phone (reached through `adb reverse`).
 * Handles `CONNECT` tunnels (HTTPS, and everything sing-box redirects on rooted boards)
 * and plain absolute-URI HTTP requests. `GET /__kmm/ping` answers locally so the agent
 * can verify the phone → adb reverse → gateway leg independently of the upstream.
 */
export class DeviceProxyListener {
  private server: http.Server | null = null;
  private clients = new Set<net.Socket>();
  private inflight = 0;
  private tunnels = 0;
  port = 0;
  private counters = { total: 0, failed: 0, bytesUp: 0, bytesDown: 0 };
  private lastActivityAt?: number;
  private lastError?: string;
  private lastErrorAt?: number;
  private lastErrorLogAt = 0;

  constructor(
    readonly deviceId: string,
    private readonly resolveRoute: () => RouteDecision,
    private readonly logger: Logger,
    private readonly opts: ListenerOptions,
  ) {}

  get stats(): ListenerStats {
    return {
      port: this.port,
      activeConnections: this.tunnels + this.inflight,
      totalConnections: this.counters.total,
      failedConnections: this.counters.failed,
      bytesUp: this.counters.bytesUp,
      bytesDown: this.counters.bytesDown,
      lastActivityAt: this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : undefined,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : undefined,
    };
  }

  /** Listen on `preferredPort` (stable across restarts so phones' reverse mapping stays valid). */
  async start(preferredPort?: number): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer({ requestTimeout: 0 });
    server.on('request', (req, res) => this.onRequest(req, res));
    server.on('connect', (req, socket, head) => this.onConnect(req, socket as net.Socket, head));
    server.on('connection', (socket: net.Socket) => {
      socket.on('error', noop);
      this.clients.add(socket);
      socket.once('close', () => this.clients.delete(socket));
    });
    server.on('clientError', (_err, socket) => socket.destroy());

    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(port, this.opts.bindHost, () => {
          server.removeListener('error', onError);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });

    try {
      this.port = await listen(preferredPort ?? 0);
    } catch (err: any) {
      if (preferredPort && err?.code === 'EADDRINUSE') {
        this.logger.warn({ deviceId: this.deviceId, preferredPort }, 'proxy: preferred gateway port busy, picking a free one');
        this.port = await listen(0);
      } else {
        throw err;
      }
    }
    server.on('error', (err) => this.logger.error({ deviceId: this.deviceId, err: err.message }, 'proxy: gateway server error'));
    this.server = server;
    this.logger.info({ deviceId: this.deviceId, port: this.port, bind: this.opts.bindHost }, 'proxy: device gateway listening');
    return this.port;
  }

  async stop(): Promise<void> {
    this.dropConnections();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.logger.info({ deviceId: this.deviceId, port: this.port }, 'proxy: device gateway stopped');
  }

  /** Kill every open connection so the next ones are routed by the current decision. */
  dropConnections(): number {
    const n = this.clients.size;
    for (const s of this.clients) s.destroy();
    this.clients.clear();
    return n;
  }

  private route(): RouteDecision {
    try {
      return this.resolveRoute();
    } catch (err) {
      return { kind: 'block', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private recordError(message: string): void {
    this.counters.failed++;
    this.lastError = message;
    this.lastErrorAt = Date.now();
    if (Date.now() - this.lastErrorLogAt > 30_000) {
      this.lastErrorLogAt = Date.now();
      this.logger.warn({ deviceId: this.deviceId, err: message }, 'proxy: gateway connection failed');
    }
  }

  private open(route: RouteDecision, host: string, port: number): Promise<net.Socket> {
    if (route.kind === 'proxy') return route.upstream.openTunnel(host, port);
    return directConnect(host, port, this.opts.directConnectTimeoutMs ?? 15_000);
  }

  private rejectSocket(client: net.Socket, status: number, message: string): void {
    if (client.destroyed) return;
    const body = `${message}\n`;
    client.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `X-Kmm-Proxy-Error: ${encodeURIComponent(message).slice(0, 300)}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n` +
        body,
    );
  }

  private onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    this.counters.total++;
    this.lastActivityAt = Date.now();
    client.on('error', noop);
    const target = parseHostPort(req.url ?? '', 443);
    if (!target) {
      this.rejectSocket(client, 400, `Некорректная цель CONNECT: ${req.url}`);
      return;
    }
    const route = this.route();
    if (route.kind === 'block') {
      this.rejectSocket(client, 403, route.reason);
      return;
    }
    this.open(route, target.host, target.port).then(
      (upstream) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        this.splice(client, upstream);
      },
      (err) => {
        const e = toProxyError(err);
        this.recordError(`${target.host}:${target.port} — ${e.message}`);
        this.rejectSocket(client, e.code === 'busy' ? 503 : 502, e.message);
      },
    );
  }

  private splice(client: net.Socket, upstream: net.Socket): void {
    this.tunnels++;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.tunnels--;
      client.destroy();
      upstream.destroy();
    };
    client.setTimeout(this.opts.idleTimeoutMs, close);
    upstream.setTimeout(this.opts.idleTimeoutMs, close);
    client.once('close', close);
    upstream.once('close', close);
    client.on('data', (d: Buffer) => {
      this.counters.bytesUp += d.length;
    });
    upstream.on('data', (d: Buffer) => {
      this.counters.bytesDown += d.length;
    });
    client.pipe(upstream);
    upstream.pipe(client);
  }

  private replyError(res: http.ServerResponse, status: number, message: string): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Kmm-Proxy-Error': encodeURIComponent(message).slice(0, 300),
      Connection: 'close',
    });
    res.end(`${message}\n`);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? '/';
    if (!/^https?:\/\//i.test(rawUrl)) {
      if (rawUrl.startsWith('/__kmm/ping')) {
        const route = this.route();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`KMM_GATEWAY_OK ${this.deviceId} ${route.kind}\n`);
        return;
      }
      this.replyError(res, 400, 'Это прокси-шлюз фермы: используйте его как HTTP-прокси');
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      this.replyError(res, 400, `Некорректный URL: ${rawUrl.slice(0, 100)}`);
      return;
    }
    this.counters.total++;
    this.lastActivityAt = Date.now();
    const route = this.route();
    if (route.kind === 'block') {
      this.replyError(res, 403, route.reason);
      return;
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = url.host;
    headers.connection = 'close';

    this.inflight++;
    let finished = false;
    const releases: Array<() => void> = [];
    res.once('close', () => {
      if (finished) return;
      finished = true;
      this.inflight--;
      releases.forEach((fn) => fn());
    });

    (async () => {
      let upstreamReq: http.ClientRequest;
      if (route.kind === 'proxy' && url.protocol === 'http:' && (await route.upstream.resolveProtocol()) === 'http') {
        const release = await route.upstream.acquireSlot();
        releases.push(release);
        const auth = route.upstream.authHeader();
        const proxySock = await route.upstream.connectRaw();
        releases.push(() => proxySock.destroy());
        upstreamReq = http.request({
          method: req.method,
          path: url.href,
          headers: auth ? { ...headers, 'proxy-authorization': auth } : headers,
          createConnection: () => {
            setImmediate(() => proxySock.resume());
            return proxySock;
          },
        } as any);
      } else {
        const sock = await this.open(route, host, port);
        releases.push(() => sock.destroy());
        const createConnection = () => {
          setImmediate(() => sock.resume());
          if (url.protocol === 'https:') {
            const secure = tls.connect({ socket: sock, servername: host });
            secure.on('error', noop);
            return secure;
          }
          return sock;
        };
        const request = url.protocol === 'https:' ? https.request : http.request;
        upstreamReq = request({ method: req.method, path: url.pathname + url.search, headers, createConnection } as any);
      }

      upstreamReq.setTimeout(this.opts.idleTimeoutMs, () => upstreamReq.destroy(new Error('таймаут ответа')));
      upstreamReq.on('response', (upRes) => {
        upRes.on('data', (d: Buffer) => {
          this.counters.bytesDown += d.length;
        });
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
      });
      upstreamReq.on('error', (err) => {
        this.recordError(`${url.host} — ${err.message}`);
        this.replyError(res, 502, `Ошибка запроса через шлюз: ${err.message}`);
      });
      req.on('data', (d: Buffer) => {
        this.counters.bytesUp += d.length;
      });
      req.pipe(upstreamReq);
    })().catch((err) => {
      const e = toProxyError(err);
      this.recordError(`${url.host} — ${e.message}`);
      this.replyError(res, e.code === 'busy' ? 503 : 502, e.message);
    });
  }
}
