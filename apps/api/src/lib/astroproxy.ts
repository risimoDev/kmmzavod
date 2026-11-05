import { db } from './db';
import { logger } from '../logger';

const ASTROPROXY_BASE_URL = 'https://astroproxy.com/api/v1';

export interface AstroProxyBalance {
  balance: number;
  currency: string;
}

export interface AstroProxyPort {
  id: number | string;
  name?: string;
  host: string;
  port: number;
  socksPort?: number;
  username?: string;
  password?: string;
  country?: string;
  city?: string;
  networkType?: string;
  status?: string;
  changeIpUrl?: string;
}

export interface AstroProxyRotationResult {
  ok: boolean;
  msg: string;
  newIp?: string;
  cooldown?: boolean;
}

/** Get the configured AstroProxy token from AdminSetting or process.env */
export async function getAstroProxyToken(): Promise<string | null> {
  try {
    const setting = await db.adminSetting.findUnique({
      where: { key: 'ASTROPROXY_API_TOKEN' },
    });
    if (setting?.value && typeof setting.value === 'string' && setting.value.trim()) {
      return setting.value.trim();
    }
    if (setting?.value && typeof setting.value === 'object' && (setting.value as any).token) {
      return String((setting.value as any).token).trim();
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to load ASTROPROXY_API_TOKEN from db');
  }
  return process.env.ASTROPROXY_API_TOKEN?.trim() || null;
}

/** Save AstroProxy token to AdminSetting */
export async function setAstroProxyToken(token: string): Promise<void> {
  const cleanToken = token.trim();
  await db.adminSetting.upsert({
    where: { key: 'ASTROPROXY_API_TOKEN' },
    create: {
      key: 'ASTROPROXY_API_TOKEN',
      value: cleanToken,
      description: 'AstroProxy API Token for automated IP rotation and balance checks',
      isPublic: false,
    },
    update: {
      value: cleanToken,
    },
  });
}

/** Fetch account balance from AstroProxy */
export async function fetchAstroProxyBalance(tokenOverride?: string): Promise<AstroProxyBalance> {
  const token = tokenOverride || (await getAstroProxyToken());
  if (!token) {
    throw new Error('AstroProxy API Token не настроен. Укажите токен в настройках фермы.');
  }

  const url = `${ASTROPROXY_BASE_URL}/balance?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-AstroProxy/1.0' } });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AstroProxy API error (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }

  const data: any = await res.json();
  // AstroProxy returns { status: "ok", balance: 2.50, currency: "USD" } or similar
  const balance = typeof data.balance === 'number' ? data.balance : parseFloat(data.balance || data.amount || '0');
  const currency = data.currency || 'USD';

  return { balance, currency };
}

/** Fetch list of ports from AstroProxy */
export async function fetchAstroProxyPorts(tokenOverride?: string): Promise<AstroProxyPort[]> {
  const token = tokenOverride || (await getAstroProxyToken());
  if (!token) {
    throw new Error('AstroProxy API Token не настроен.');
  }

  const url = `${ASTROPROXY_BASE_URL}/ports?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-AstroProxy/1.0' } });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AstroProxy API error (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }

  const data: any = await res.json();
  const rawPorts: any[] = Array.isArray(data) ? data : data.ports || data.data || [];

  return rawPorts.map((p) => {
    const id = p.id || p.port_id;
    const host = p.ip || p.host || p.server || (p.connection && p.connection.ip) || '';
    const port = Number(p.port || (p.ports && p.ports.http) || (p.connection && p.connection.http_port) || 0);
    const socksPort = Number((p.ports && p.ports.socks) || (p.connection && p.connection.socks_port) || port);
    const username = p.login || p.username || (p.auth && p.auth.login) || '';
    const password = p.password || (p.auth && p.auth.password) || '';
    const country = p.country || p.country_name || '';
    const city = p.city || '';
    const networkType = p.type || p.network_type || '';
    const status = p.status || p.state || 'active';
    const changeIpUrl = p.change_ip_url || p.link_change_ip || `${ASTROPROXY_BASE_URL}/ports/${id}/newip?token=${encodeURIComponent(token)}`;

    return {
      id,
      name: p.name || `Port #${id}`,
      host,
      port,
      socksPort,
      username,
      password,
      country,
      city,
      networkType,
      status,
      changeIpUrl,
    };
  });
}

/** Trigger IP rotation for an AstroProxy port */
export async function rotateAstroProxyPort(
  portId: number | string,
  tokenOverride?: string,
): Promise<AstroProxyRotationResult> {
  const token = tokenOverride || (await getAstroProxyToken());
  if (!token) {
    throw new Error('AstroProxy API Token не настроен.');
  }

  const url = `${ASTROPROXY_BASE_URL}/ports/${portId}/newip?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-AstroProxy/1.0' } });
  const text = await res.text().catch(() => '');

  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  // Check cooldown or errors
  const isCooldown =
    res.status === 429 ||
    String(data.msg || text).toLowerCase().includes('cooldown') ||
    String(data.error || '').toLowerCase().includes('cooldown') ||
    String(data.msg || text).toLowerCase().includes('wait');

  if (!res.ok && !isCooldown) {
    throw new Error(`AstroProxy rotation error (${res.status}): ${data.msg || data.error || text.slice(0, 200)}`);
  }

  return {
    ok: res.ok,
    msg: data.msg || data.message || (isCooldown ? 'Кулдаун ротации (подождите 30 сек)' : 'IP успешно изменен'),
    newIp: data.new_ip || data.ip,
    cooldown: isCooldown,
  };
}
