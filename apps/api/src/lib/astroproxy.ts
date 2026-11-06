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

interface CachedData<T> {
  data: T;
  timestamp: number;
}

// In-memory cache to strictly avoid AstroProxy 429 rate limit (AstroProxy limits /ports to 1 req/min)
let cachedPorts: CachedData<AstroProxyPort[]> | null = null;
let cachedBalance: CachedData<AstroProxyBalance> | null = null;
const PORTS_CACHE_TTL_MS = 90_000; // 90 seconds
const BALANCE_CACHE_TTL_MS = 30_000; // 30 seconds

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

async function getStoredCachedPorts(): Promise<AstroProxyPort[] | null> {
  try {
    const setting = await db.adminSetting.findUnique({
      where: { key: 'ASTROPROXY_CACHED_PORTS' },
    });
    if (setting?.value && Array.isArray(setting.value) && setting.value.length > 0) {
      return setting.value as unknown as AstroProxyPort[];
    }
  } catch {
    // ignore
  }
  return null;
}

async function saveStoredCachedPorts(ports: AstroProxyPort[]): Promise<void> {
  if (!ports || ports.length === 0) return;
  try {
    await db.adminSetting.upsert({
      where: { key: 'ASTROPROXY_CACHED_PORTS' },
      create: {
        key: 'ASTROPROXY_CACHED_PORTS',
        value: ports as any,
        description: 'Cached AstroProxy ports list',
        isPublic: false,
      },
      update: {
        value: ports as any,
      },
    });
  } catch {
    // ignore
  }
}

/** Fetch account balance from AstroProxy with caching */
export async function fetchAstroProxyBalance(tokenOverride?: string, forceRefresh = false): Promise<AstroProxyBalance> {
  const token = tokenOverride || (await getAstroProxyToken());
  if (!token) {
    throw new Error('AstroProxy API Token не настроен. Укажите токен в настройках фермы.');
  }

  if (!forceRefresh && cachedBalance && Date.now() - cachedBalance.timestamp < BALANCE_CACHE_TTL_MS) {
    return cachedBalance.data;
  }

  const url = `${ASTROPROXY_BASE_URL}/balance?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-AstroProxy/1.0' } });

  if (!res.ok) {
    if (res.status === 429 && cachedBalance?.data) {
      return cachedBalance.data;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`AstroProxy API error (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }

  const data: any = await res.json();
  if (data.status && data.status !== 'ok' && data.status !== 'success') {
    throw new Error(data.message || data.msg || 'Ошибка получения баланса AstroProxy');
  }

  const balanceData = data.data && typeof data.data === 'object' ? data.data : data;
  const balance = typeof balanceData.balance === 'number'
    ? balanceData.balance
    : parseFloat(balanceData.balance || balanceData.amount || data.balance || '0');
  const currency = balanceData.currency || data.currency || 'USD';

  const result = { balance, currency };
  cachedBalance = { data: result, timestamp: Date.now() };
  return result;
}

/** Fetch list of ports from AstroProxy with caching and rate limit fallback */
export async function fetchAstroProxyPorts(tokenOverride?: string, forceRefresh = false): Promise<AstroProxyPort[]> {
  const token = tokenOverride || (await getAstroProxyToken());
  if (!token) {
    throw new Error('AstroProxy API Token не настроен.');
  }

  // 1. Check in-memory cache
  if (!forceRefresh && cachedPorts && Date.now() - cachedPorts.timestamp < PORTS_CACHE_TTL_MS) {
    return cachedPorts.data;
  }

  const url = `${ASTROPROXY_BASE_URL}/ports?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-AstroProxy/1.0' } });

  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // 2. On 429 rate limit: fall back to in-memory or DB cached ports immediately
    if (res.status === 429 || text.includes('1 minutes') || text.includes('rate limit')) {
      if (cachedPorts?.data && cachedPorts.data.length > 0) {
        logger.info('AstroProxy 429 rate limit hit — using in-memory cached ports');
        return cachedPorts.data;
      }
      const dbPorts = await getStoredCachedPorts();
      if (dbPorts && dbPorts.length > 0) {
        logger.info('AstroProxy 429 rate limit hit — using DB cached ports');
        cachedPorts = { data: dbPorts, timestamp: Date.now() };
        return dbPorts;
      }
      throw new Error('AstroProxy ограничивает частоту запросов портов (1 раз в минуту). Подождите 30-40 секунд и повторите.');
    }

    throw new Error(`AstroProxy API error (${res.status}): ${text.slice(0, 200) || res.statusText}`);
  }

  const data: any = await res.json();
  if (data.status && data.status !== 'ok' && data.status !== 'success') {
    throw new Error(data.message || data.msg || 'Ошибка получения портов AstroProxy');
  }

  let rawPorts: any[] = [];
  if (Array.isArray(data)) {
    rawPorts = data;
  } else if (data.data && Array.isArray(data.data.ports)) {
    rawPorts = data.data.ports;
  } else if (Array.isArray(data.ports)) {
    rawPorts = data.ports;
  } else if (Array.isArray(data.data)) {
    rawPorts = data.data;
  } else if (data.data?.ports && typeof data.data.ports === 'object') {
    rawPorts = Object.values(data.data.ports);
  } else if (data.ports && typeof data.ports === 'object') {
    rawPorts = Object.values(data.ports);
  } else if (data.data && typeof data.data === 'object') {
    rawPorts = Object.values(data.data);
  }

  const ports: AstroProxyPort[] = rawPorts.map((p) => {
    const id = p.id || p.port_id;
    const node = p.node || {};
    const portsObj = p.ports || {};
    const access = p.access || {};
    const connection = p.connection || {};

    const host = node.ip || node.address || p.ip || p.host || p.server || connection.ip || '';
    const port = Number(portsObj.http || p.port || connection.http_port || 0);
    const socksPort = Number(portsObj.socks || connection.socks_port || port);
    const username = access.login || p.login || p.username || (p.auth && p.auth.login) || '';
    const password = access.password || p.password || (p.auth && p.auth.password) || '';
    const country = p.country || p.country_name || '';
    const city = p.city || '';
    const networkType = p.network || p.type || p.network_type || '';
    const status = p.status || p.state || 'active';
    const changeIpUrl = p.change_ip_url || p.link_change_ip || (p.changeIpUrl ? String(p.changeIpUrl) : undefined) || `${ASTROPROXY_BASE_URL}/ports/${id}/newip?token=${encodeURIComponent(token)}`;

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

  cachedPorts = { data: ports, timestamp: Date.now() };
  // Save to DB in background
  saveStoredCachedPorts(ports).catch(() => {});

  return ports;
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

  const isCooldown =
    res.status === 429 ||
    String(data.msg || data.message || text).toLowerCase().includes('cooldown') ||
    String(data.error || '').toLowerCase().includes('cooldown') ||
    String(data.msg || data.message || text).toLowerCase().includes('wait');

  if (!res.ok && !isCooldown) {
    throw new Error(`AstroProxy rotation error (${res.status}): ${data.message || data.msg || data.error || text.slice(0, 200)}`);
  }

  const newIp = data.data?.ip || data.new_ip || data.ip;

  return {
    ok: res.ok,
    msg: data.message || data.msg || (isCooldown ? 'Кулдаун ротации (подождите 30 сек)' : 'IP успешно изменен'),
    newIp,
    cooldown: isCooldown,
  };
}
