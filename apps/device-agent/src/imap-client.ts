/**
 * Minimal, zero-dependency IMAP client over Node TLS for fetching verification
 * codes (2FA / OTP) from email (Instagram, TikTok, etc.).
 *
 * Supports major mail providers:
 *  - mail.ru / inbox.ru / bk.ru / list.ru / internet.ru (imap.mail.ru:993)
 *  - yandex.ru / ya.ru / yandex.com (imap.yandex.ru:993)
 *  - rambler.ru / lenta.ru / ro.ru (imap.rambler.ru:993)
 *  - gmail.com / googlemail.com (imap.gmail.com:993)
 *  - outlook.com / hotmail.com / live.com (outlook.office365.com:993)
 *  - Custom IMAP server host & port
 */
import tls from 'node:tls';

export interface ImapConfig {
  email: string;
  password?: string;
  host?: string;
  port?: number;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthClientId?: string;
}

export interface VerificationCodeResult {
  ok: boolean;
  code?: string;
  subject?: string;
  from?: string;
  date?: string;
  error?: string;
}

export function isMicrosoftImap(email: string, host = detectImapHost(email).host): boolean {
  return host.toLowerCase() === 'outlook.office365.com' || /@(?:outlook|hotmail|live|msn)\.com$/i.test(email);
}

/** Automatically determine default IMAP host & port from email domain. */
export function detectImapHost(email: string): { host: string; port: number } {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru'].includes(domain)) {
    return { host: 'imap.mail.ru', port: 993 };
  }
  if (['yandex.ru', 'ya.ru', 'yandex.com', 'narod.ru'].includes(domain)) {
    return { host: 'imap.yandex.ru', port: 993 };
  }
  if (['rambler.ru', 'lenta.ru', 'autorambler.ru', 'myrambler.ru', 'ro.ru'].includes(domain)) {
    return { host: 'imap.rambler.ru', port: 993 };
  }
  if (['gmail.com', 'googlemail.com'].includes(domain)) {
    return { host: 'imap.gmail.com', port: 993 };
  }
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) {
    return { host: 'outlook.office365.com', port: 993 };
  }
  if (['yahoo.com', 'ymail.com'].includes(domain)) {
    return { host: 'imap.mail.yahoo.com', port: 993 };
  }
  if (['icloud.com', 'me.com'].includes(domain)) {
    return { host: 'imap.mail.me.com', port: 993 };
  }
  if (['vk.com', 'vk.ru'].includes(domain)) {
    return { host: 'imap.mail.ru', port: 993 };
  }
  return { host: `imap.${domain || 'mail.ru'}`, port: 993 };
}

function imapEndpoint(cfg: ImapConfig): { host: string; port: number } {
  if (isMicrosoftImap(cfg.email, cfg.host)) return { host: 'outlook.office365.com', port: 993 };
  return cfg.host ? { host: cfg.host, port: cfg.port ?? 993 } : detectImapHost(cfg.email);
}

/** Format IMAP errors into helpful, actionable messages and identify permanent auth failures. */
export function formatImapError(err: Error | string, email: string, host: string): { message: string; isPermanentAuth: boolean } {
  const raw = typeof err === 'string' ? err : err.message || String(err);
  const domain = (email.split('@')[1] || '').toLowerCase().trim();

  const isPermanentAuth =
    /basic authentication is disabled|authenticationfailed|invalid credentials|login failed|not accepted|application-specific password|password for application|bad credentials|требует Microsoft OAuth2|OAuth2 Error|Microsoft OAuth.*(?:400|401|403)/i.test(
      raw,
    );

  if (/basic authentication is disabled/i.test(raw) || isMicrosoftImap(email, host)) {
    if (isPermanentAuth) {
      return {
        message: 'Microsoft IMAP: проверьте OAuth2 для этого ящика и включите IMAP в Outlook. Код можно ввести на телефоне вручную.',
        isPermanentAuth: true,
      };
    }
  }

  if (domain.includes('mail.ru') || domain.includes('inbox.ru') || domain.includes('bk.ru') || domain.includes('list.ru')) {
    if (isPermanentAuth) {
      return {
        message: `Mail.ru IMAP: ошибка авторизации. Для доступа по IMAP создайте «Пароль для внешних приложений» (Настройки почты Mail.ru -> Пароль и безопасность -> Пароли для внешних приложений).`,
        isPermanentAuth: true,
      };
    }
  }

  if (domain.includes('yandex.') || domain.includes('ya.ru')) {
    if (isPermanentAuth) {
      return {
        message: `Яндекс IMAP: ошибка авторизации. Создайте «Пароль приложений» (id.yandex.ru -> Безопасность -> Пароли приложений -> Почта).`,
        isPermanentAuth: true,
      };
    }
  }

  if (domain.includes('gmail.') || domain.includes('googlemail.')) {
    if (isPermanentAuth) {
      return {
        message: `Gmail IMAP: ошибка авторизации. Требуется создать «Пароль приложений» Google (myaccount.google.com/apppasswords, требует 2FA).`,
        isPermanentAuth: true,
      };
    }
  }

  return {
    message: isPermanentAuth ? 'IMAP отклонил данные авторизации' : 'Не удалось подключиться к ящику или прочитать IMAP',
    isPermanentAuth,
  };
}

/** Exchange a Microsoft mailbox refresh token using the client that obtained consent. */
export async function refreshMicrosoftToken(
  refreshToken: string,
  clientId: string,
): Promise<string> {
  const cleanToken = refreshToken.trim();
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: cleanToken,
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
  });

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Microsoft OAuth токен отклонён (${res.status})`);
  }

  const data = (await res.json()) as any;
  if (!data.access_token) {
    throw new Error('Ответ Microsoft OAuth не содержит access_token');
  }
  return data.access_token;
}

/** Extract 4 to 8 digit verification code from message subject or body text. */
export function extractVerificationCode(text: string, platform?: 'tiktok' | 'instagram', requireCodeMarker = false): string | null {
  if (!text) return null;

  // Clean HTML tags and decode common entities
  const clean = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');

  // 1. High confidence patterns with keywords:
  // e.g. "code is 123456", "код: 123 456", "Verification code: 123456", "123456 is your TikTok code"
  const keywordPatterns = [
    /(?:verification\s*code|security\s*code|confirmation\s*code|код\s*подтверждения|проверочный\s*код|ваш\s*код|login\s*code|two-factor\s*code)[\s:=—–-]*([0-9]{4,8}|[0-9]{3}\s[0-9]{3})/i,
    /([0-9]{6}|[0-9]{3}\s[0-9]{3})\s*(?:is\s*your\s*(?:Instagram|TikTok|verification|security)\s*code|это\s*ваш\s*код)/i,
    /(?:Instagram|TikTok)[\s\S]{0,30}?(?:code|код)[\s:=—–-]*([0-9]{4,8}|[0-9]{3}\s[0-9]{3})/i,
    /(?:enter|введите)[\s\S]{0,20}?([0-9]{6}|[0-9]{4})/i,
    /([0-9]{6})\s*[-—–]\s*(?:Instagram|TikTok)/i,
    /\[(?:TikTok|Instagram)\][\s\S]{0,30}?([0-9]{4,8})/i,
  ];

  for (const pattern of keywordPatterns) {
    const match = clean.match(pattern);
    if (match && match[1]) {
      const code = match[1].replace(/\s+/g, '').trim();
      if (/^\d{4,8}$/.test(code) && !isExcludedCode(code)) {
        return code;
      }
    }
  }

  if (requireCodeMarker) return null;

  // 2. Generic 6-digit match if message is clearly from Instagram or TikTok
  const isPlatformMessage =
    platform === 'instagram' ||
    platform === 'tiktok' ||
    /instagram|tiktok|security@mail\.instagram\.com|tiktok\.com/i.test(clean);

  if (isPlatformMessage) {
    const matches = clean.match(/\b\d{6}\b/g);
    if (matches) {
      for (const m of matches) {
        if (!isExcludedCode(m)) {
          return m;
        }
      }
    }
    // Check 4-digit code (some SMS/email fallbacks use 4 digits)
    const matches4 = clean.match(/\b\d{4}\b/g);
    if (matches4) {
      for (const m of matches4) {
        if (!isExcludedCode(m)) {
          return m;
        }
      }
    }
  }

  return null;
}

function isExcludedCode(code: string): boolean {
  // Exclude current/adjacent years, typical ports, zero strings
  const n = Number(code);
  if (n >= 1990 && n <= 2040) return true;
  if (/^(0{4,8}|1{4,8}|9{4,8})$/.test(code)) return true;
  if (['8080', '8443', '3000', '5000', '9000'].includes(code)) return true;
  return false;
}

/**
 * Raw IMAP TLS Session Runner.
 */
class ImapSession {
  private socket: tls.TLSSocket | null = null;
  private buffer = '';
  private tagIndex = 1;

  async connect(host: string, port: number, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy();
        reject(new Error(`IMAP connection timeout to ${host}:${port}`));
      }, timeoutMs);

      try {
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
          clearTimeout(timer);
          resolve();
        });
        this.socket = socket;

        socket.on('data', (chunk) => {
          this.buffer += chunk.toString('utf-8');
        });

        socket.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  destroy(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async readUntil(predicate: (buf: string) => boolean, timeoutMs = 15_000): Promise<string> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (predicate(this.buffer)) {
        const result = this.buffer;
        return result;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`IMAP response timeout (${timeoutMs}ms)`);
  }

  async sendCommand(cmd: string, timeoutMs = 20_000): Promise<string> {
    if (!this.socket) throw new Error('Not connected');
    const tag = `A${this.tagIndex++}`;
    const fullCmd = `${tag} ${cmd}\r\n`;

    // Clear previous buffer before next tagged response
    this.buffer = '';
    this.socket.write(fullCmd);

    const out = await this.readUntil((b) => b.includes(`${tag} OK`) || b.includes(`${tag} NO`) || b.includes(`${tag} BAD`), timeoutMs);
    if (out.includes(`${tag} NO`) || out.includes(`${tag} BAD`)) {
      const match = out.match(new RegExp(`${tag}\\s+(?:NO|BAD)\\s+([^\\r\\n]+)`, 'i'));
      const reason = match ? match[1] : 'Command rejected';
      throw new Error(/^LOGIN /i.test(cmd) ? 'IMAP login failed' : `IMAP Error: ${reason}`);
    }
    return out;
  }

  /**
   * Authenticate via modern OAuth2 (XOAUTH2) if tokens provided, or fall back to standard LOGIN.
   */
  async authenticate(cfg: ImapConfig): Promise<void> {
    const isOutlook = isMicrosoftImap(cfg.email, cfg.host);

    // 1. Direct access token provided
    if (cfg.oauthAccessToken) {
      await this.authenticateXOAuth2(cfg.email, cfg.oauthAccessToken);
      return;
    }

    // 2. Explicit mailbox OAuth credentials only.
    if (isOutlook && cfg.oauthRefreshToken && cfg.oauthClientId) {
      const accessToken = await refreshMicrosoftToken(cfg.oauthRefreshToken, cfg.oauthClientId);
      await this.authenticateXOAuth2(cfg.email, accessToken);
      return;
    }

    if (isOutlook) throw new Error('Outlook требует Microsoft OAuth2');
    // 3. Standard IMAP LOGIN
    const pass = cfg.password || '';
    if (!pass || /[\r\n]/.test(pass + cfg.email)) {
      throw new Error('Пароль от почты не указан');
    }
    const safeUser = cfg.email.replace(/["\\]/g, '\\$&');
    const safePass = pass.replace(/["\\]/g, '\\$&');
    await this.sendCommand(`LOGIN "${safeUser}" "${safePass}"`, 12_000);
  }

  async authenticateXOAuth2(email: string, accessToken: string, timeoutMs = 15_000): Promise<string> {
    if (!this.socket) throw new Error('Not connected');
    const tag = `A${this.tagIndex++}`;
    const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
    const base64Auth = Buffer.from(authString, 'utf-8').toString('base64');
    const fullCmd = `${tag} AUTHENTICATE XOAUTH2 ${base64Auth}\r\n`;

    this.buffer = '';
    this.socket.write(fullCmd);

    const out = await this.readUntil(
      (b) => b.includes(`${tag} OK`) || b.includes(`${tag} NO`) || b.includes(`${tag} BAD`) || b.includes('+ '),
      timeoutMs,
    );

    // If server issues a challenge (e.g. "+ ..."), send empty line to trigger completion or error response
    if (out.includes('+ ') && !out.includes(`${tag} `)) {
      this.buffer = '';
      this.socket.write('\r\n');
      const finalOut = await this.readUntil(
        (b) => b.includes(`${tag} OK`) || b.includes(`${tag} NO`) || b.includes(`${tag} BAD`),
        timeoutMs,
      );
      if (finalOut.includes(`${tag} NO`) || finalOut.includes(`${tag} BAD`)) {
        const match = finalOut.match(new RegExp(`${tag}\\s+(?:NO|BAD)\\s+([^\\r\\n]+)`, 'i'));
        const reason = match ? match[1] : 'XOAUTH2 rejected';
        throw new Error(`IMAP XOAUTH2 Error: ${reason}`);
      }
      return finalOut;
    }

    if (out.includes(`${tag} NO`) || out.includes(`${tag} BAD`)) {
      const match = out.match(new RegExp(`${tag}\\s+(?:NO|BAD)\\s+([^\\r\\n]+)`, 'i'));
      const reason = match ? match[1] : 'XOAUTH2 rejected';
      throw new Error(`IMAP XOAUTH2 Error: ${reason}`);
    }
    return out;
  }
}

/**
 * Verify IMAP credentials and inbox access.
 */
export async function testImapConnection(cfg: ImapConfig): Promise<{ ok: boolean; messageCount?: number; error?: string }> {
  const { host, port } = imapEndpoint(cfg);
  const session = new ImapSession();

  try {
    await session.connect(host, port, 12_000);
    // Read greeting
    await session.readUntil((b) => b.startsWith('* OK') || b.includes('\r\n'), 8000);

    await session.authenticate({ ...cfg, host, port });

    const selectOut = await session.sendCommand('EXAMINE INBOX', 10_000);
    const countMatch = selectOut.match(/\*\s+(\d+)\s+EXISTS/i);
    const messageCount = countMatch ? parseInt(countMatch[1], 10) : 0;

    await session.sendCommand(`LOGOUT`, 4000).catch(() => {});
    session.destroy();

    return { ok: true, messageCount };
  } catch (err: any) {
    session.destroy();
    const formatted = formatImapError(err, cfg.email, host);
    return { ok: false, error: formatted.message };
  }
}

/**
 * Poll IMAP inbox for the latest verification code from Instagram or TikTok.
 */
export async function pollVerificationCode(
  cfg: ImapConfig,
  opts: {
    platform?: 'tiktok' | 'instagram';
    maxWaitSec?: number;
    pollIntervalMs?: number;
    receivedAfter?: Date;
  } = {},
): Promise<VerificationCodeResult> {
  const { platform, maxWaitSec = 90, pollIntervalMs = 4000, receivedAfter = new Date(Date.now() - 120_000) } = opts;
  const requireCodeMarker = opts.receivedAfter !== undefined;
  const microsoft = isMicrosoftImap(cfg.email, cfg.host);
  const { host, port } = imapEndpoint(cfg);
  if (microsoft && !cfg.oauthAccessToken) {
    if (!cfg.oauthRefreshToken || !cfg.oauthClientId) {
      return { ok: false, error: formatImapError('Outlook требует Microsoft OAuth2', cfg.email, host).message };
    }
    try {
      const oauthAccessToken = await refreshMicrosoftToken(cfg.oauthRefreshToken, cfg.oauthClientId);
      cfg = { ...cfg, oauthAccessToken };
    } catch (err) {
      return { ok: false, error: formatImapError(err as Error, cfg.email, host).message };
    }
  }

  const deadline = Date.now() + maxWaitSec * 1000;
  const searchSince = new Date(receivedAfter.getTime() - 86_400_000).toUTCString().slice(5, 16).replace(/ /g, '-');
  let lastError = '';

  while (Date.now() < deadline) {
    const session = new ImapSession();
    try {
      await session.connect(host, port, 10_000);
      await session.readUntil((b) => b.startsWith('* OK') || b.includes('\r\n'), 6000);

      await session.authenticate({ ...cfg, host, port });
      await session.sendCommand('EXAMINE INBOX', 8000);
      const searchOut = await session.sendCommand(`UID SEARCH SINCE ${searchSince}`, 8000);
      const uids = (searchOut.match(/^\* SEARCH((?: \d+)*)/m)?.[1] ?? '').trim().split(/ +/).filter(Boolean).slice(-12).reverse();

      for (const id of uids) {
        if (Date.now() >= deadline) break;
        try {
          const headers = await session.sendCommand(`UID FETCH ${id} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])`, 8000);
          if (!isRecentVerificationMessage(headers, platform, receivedAfter)) continue;
          const subject = /^Subject:[ \t]*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? '';
          const code = extractVerificationCode(subject, platform, requireCodeMarker) ?? extractVerificationCode(
            await session.sendCommand(`UID FETCH ${id} (BODY.PEEK[TEXT]<0.16384>)`, 8000), platform, requireCodeMarker,
          );
          if (!code) continue;
          await session.sendCommand('LOGOUT', 3000).catch(() => {});
          session.destroy();
          return { ok: true, code, subject };
        } catch {
          // continue checking other messages
        }
      }

      await session.sendCommand(`LOGOUT`, 3000).catch(() => {});
      session.destroy();
    } catch (err: any) {
      session.destroy();
      const formatted = formatImapError(err, cfg.email, host);
      lastError = formatted.message;

      // Fail fast immediately on permanent authentication errors (e.g. Basic auth disabled, wrong pass)
      if (formatted.isPermanentAuth) {
        return {
          ok: false,
          error: formatted.message,
        };
      }
    }

    const wait = Math.min(deadline - Date.now(), pollIntervalMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  return {
    ok: false,
    error: `Код подтверждения не поступил в течение ${maxWaitSec} сек` + (lastError ? `: ${lastError}` : ''),
  };
}

export function isRecentVerificationMessage(raw: string, platform: 'tiktok' | 'instagram' | undefined, receivedAfter: Date): boolean {
  const date = /^\* [^\r\n]*\bINTERNALDATE "([^"]+)"/im.exec(raw)?.[1];
  if (!date || !(Date.parse(date) >= Math.floor(receivedAfter.getTime() / 1000) * 1000)) return false;
  if (!platform) return true;
  const from = /^From:[ \t]*([^\r\n]+)/im.exec(raw)?.[1]?.trim() ?? '';
  const domain = /@([a-z\d.-]+)>?$/i.exec(from)?.[1].toLowerCase();
  if (!domain) return false;
  return platform === 'tiktok' ? /(?:^|\.)tiktok\.com$/.test(domain) : /(?:^|\.)(?:instagram\.com|facebookmail\.com)$/.test(domain);
}
