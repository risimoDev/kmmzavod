import type { PrismaClient } from '@kmmzavod/db';
import { logger } from '../logger';
import { deviceAgentService } from '../services/device-agent';

const ASTROPROXY_BASE_URL = 'https://astroproxy.com/api/v1';

/** Retrieve AstroProxy API token from AdminSetting or process.env */
export async function getAstroProxyToken(db: PrismaClient): Promise<string | null> {
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
    logger.warn({ err: String(err) }, 'AstroProxy: failed to read token from AdminSetting, falling back to env');
  }
  return process.env.ASTROPROXY_API_TOKEN?.trim() || null;
}

/** Retrieve active AstroProxy ports */
export async function fetchAstroProxyPorts(db: PrismaClient, token: string): Promise<any[]> {
  try {
    const url = `${ASTROPROXY_BASE_URL}/ports?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-Orchestrator-AstroProxy/1.0' } });
    if (!res.ok) {
      const setting = await db.adminSetting.findUnique({ where: { key: 'ASTROPROXY_CACHED_PORTS' } }).catch(() => null);
      if (setting?.value && Array.isArray(setting.value)) return setting.value as any[];
      return [];
    }
    const data: any = await res.json();
    const ports = Array.isArray(data) ? data : (data.ports || data.data || []);
    return ports;
  } catch {
    const setting = await db.adminSetting.findUnique({ where: { key: 'ASTROPROXY_CACHED_PORTS' } }).catch(() => null);
    if (setting?.value && Array.isArray(setting.value)) return setting.value as any[];
    return [];
  }
}

/** Trigger IP rotation for an AstroProxy port */
export async function rotateAstroProxyPort(
  portId: number | string,
  token: string,
): Promise<{ ok: boolean; msg: string; newIp?: string; cooldown?: boolean }> {
  const url = `${ASTROPROXY_BASE_URL}/ports/${portId}/newip?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KMMZavod-Orchestrator-AstroProxy/1.0' } });
  const text = await res.text().catch(() => '');
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const isCooldown =
    res.status === 429 ||
    String(data.msg || data.message || text).toLowerCase().includes('cooldown') ||
    String(data.error || '').toLowerCase().includes('cooldown') ||
    String(data.msg || data.message || text).toLowerCase().includes('wait');
  const newIp = data.data?.ip || data.new_ip || data.ip;
  return {
    ok: res.ok,
    msg: data.message || data.msg || (isCooldown ? 'Кулдаун ротации (подождите 30 сек)' : 'IP успешно изменен'),
    newIp,
    cooldown: isCooldown,
  };
}

/**
 * Full rotation cycle for a rack phone board:
 * 1. Checks if AstroProxy token is configured. If so, calls official AstroProxy API port rotation.
 * 2. Informs device-agent to switch IP via rotation link, drop old connections and verify fresh public IP.
 * 3. Returns the new IP and country.
 */
export async function rotateIpForFarmDevice(
  db: PrismaClient,
  deviceId: string,
  proxyUrlOverride?: string | null,
): Promise<{ ok: boolean; newIp?: string; country?: string; msg?: string }> {
  const token = await getAstroProxyToken(db);
  let rotateUrl: string | undefined;

  if (token) {
    try {
      const ports = await fetchAstroProxyPorts(db, token);
      if (ports.length > 0) {
        const port = ports[0];
        const portId = port.id || port._id;
        if (portId) {
          rotateUrl = port.changeIpUrl || `${ASTROPROXY_BASE_URL}/ports/${portId}/newip?token=${encodeURIComponent(token)}`;
          const astroRes = await rotateAstroProxyPort(portId, token).catch((e) => {
            logger.warn({ err: String(e), portId }, 'AstroProxy: port rotation API returned non-200');
            return null;
          });
          if (astroRes?.ok && astroRes.newIp) {
            logger.info({ deviceId, newIp: astroRes.newIp }, 'AstroProxy: API confirmed new exit IP');
          }
        }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'AstroProxy: error fetching ports for rotation');
    }
  }

  // Call device-agent to trigger modem rotation and verify board's real exit IP
  try {
    const res = await deviceAgentService.rotateProxyIp(deviceId, rotateUrl, 10_000);
    return {
      ok: res.ok,
      newIp: res.check?.ip,
      country: res.check?.country,
      msg: res.rotateResponse || (res.ok ? 'IP успешно обновлен' : res.error),
    };
  } catch (err: any) {
    logger.warn({ err: String(err), deviceId }, 'AstroProxy: deviceAgentService.rotateProxyIp warning');
    const check = await deviceAgentService.checkDeviceIp(deviceId).catch(() => null);
    return {
      ok: Boolean(check?.ok),
      newIp: check?.ip,
      country: check?.country,
      msg: String(err?.message || err),
    };
  }
}
