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
  password: string;
  host?: string;
  port?: number;
}

export interface VerificationCodeResult {
  ok: boolean;
  code?: string;
  subject?: string;
  from?: string;
  date?: string;
  error?: string;
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

/** Extract 4 to 8 digit verification code from message subject or body text. */
export function extractVerificationCode(text: string, platform?: 'tiktok' | 'instagram'): string | null {
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
        const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
          clearTimeout(timer);
          this.socket = socket;
          resolve();
        });

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
      throw new Error(`IMAP Error: ${reason}`);
    }
    return out;
  }
}

/**
 * Verify IMAP credentials and inbox access.
 */
export async function testImapConnection(cfg: ImapConfig): Promise<{ ok: boolean; messageCount?: number; error?: string }> {
  const { host, port } = cfg.host && cfg.port ? { host: cfg.host, port: cfg.port } : detectImapHost(cfg.email);
  const session = new ImapSession();

  try {
    await session.connect(host, port, 12_000);
    // Read greeting
    await session.readUntil((b) => b.startsWith('* OK') || b.includes('\r\n'), 8000);

    // Escape quotes in password
    const safeUser = cfg.email.replace(/["\\]/g, '\\$&');
    const safePass = cfg.password.replace(/["\\]/g, '\\$&');
    await session.sendCommand(`LOGIN "${safeUser}" "${safePass}"`, 12_000);

    const selectOut = await session.sendCommand(`SELECT INBOX`, 10_000);
    const countMatch = selectOut.match(/\*\s+(\d+)\s+EXISTS/i);
    const messageCount = countMatch ? parseInt(countMatch[1], 10) : 0;

    await session.sendCommand(`LOGOUT`, 4000).catch(() => {});
    session.destroy();

    return { ok: true, messageCount };
  } catch (err: any) {
    session.destroy();
    return { ok: false, error: err.message || String(err) };
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
  const { host, port } = cfg.host && cfg.port ? { host: cfg.host, port: cfg.port } : detectImapHost(cfg.email);

  const startTime = Date.now();
  let lastError = '';

  while (Date.now() - startTime < maxWaitSec * 1000) {
    const session = new ImapSession();
    try {
      await session.connect(host, port, 10_000);
      await session.readUntil((b) => b.startsWith('* OK') || b.includes('\r\n'), 6000);

      const safeUser = cfg.email.replace(/["\\]/g, '\\$&');
      const safePass = cfg.password.replace(/["\\]/g, '\\$&');
      await session.sendCommand(`LOGIN "${safeUser}" "${safePass}"`, 10_000);
      await session.sendCommand(`SELECT INBOX`, 8000);

      // Search recent messages (UNSEEN or all recent)
      let searchOut = await session.sendCommand(`SEARCH UNSEEN`, 8000).catch(() => '');
      let uids = (searchOut.match(/\*\s+SEARCH\s+(.*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean);

      if (uids.length === 0) {
        // Fallback: search ALL and inspect last 8 messages
        searchOut = await session.sendCommand(`SEARCH ALL`, 8000).catch(() => '');
        const allUids = (searchOut.match(/\*\s+SEARCH\s+(.*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean);
        uids = allUids.slice(-8).reverse();
      } else {
        uids = uids.reverse();
      }

      for (const id of uids) {
        try {
          const fetchOut = await session.sendCommand(`FETCH ${id} (BODY[HEADER.FIELDS (SUBJECT FROM DATE)] BODY[TEXT])`, 10_000);
          const subjMatch = fetchOut.match(/Subject:\s*([^\r\n]+)/i);
          const fromMatch = fetchOut.match(/From:\s*([^\r\n]+)/i);
          const dateMatch = fetchOut.match(/Date:\s*([^\r\n]+)/i);

          const subject = subjMatch ? subjMatch[1].trim() : '';
          const from = fromMatch ? fromMatch[1].trim() : '';
          const dateStr = dateMatch ? dateMatch[1].trim() : '';

          // Check if message is related to target platform
          const isRelevant =
            !platform ||
            (platform === 'instagram' && /instagram/i.test(`${from} ${subject} ${fetchOut}`)) ||
            (platform === 'tiktok' && /tiktok/i.test(`${from} ${subject} ${fetchOut}`)) ||
            /verification|security|confirm|code|код/i.test(`${subject} ${fetchOut}`);

          if (isRelevant) {
            const code = extractVerificationCode(`${subject}\n${fetchOut}`, platform);
            if (code) {
              await session.sendCommand(`LOGOUT`, 3000).catch(() => {});
              session.destroy();
              return {
                ok: true,
                code,
                subject,
                from,
                date: dateStr,
              };
            }
          }
        } catch {
          // continue checking other messages
        }
      }

      await session.sendCommand(`LOGOUT`, 3000).catch(() => {});
      session.destroy();
    } catch (err: any) {
      session.destroy();
      lastError = err.message || String(err);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return {
    ok: false,
    error: `Код подтверждения не поступил на почту ${cfg.email} в течение ${maxWaitSec} сек` + (lastError ? `: ${lastError}` : ''),
  };
}
