#!/usr/bin/env node
// Lightweight proxy/network diagnostics for server environment.
// Usage: AI_PROXY_URL="http://user:pass@host:port" node scripts/check-proxy.mjs
import dns from 'dns/promises';
import net from 'net';
import { fileURLToPath } from 'url';

const PROBE_HOST = process.argv[2] || 'api.heygen.com';
const proxyUrl = process.env.AI_PROXY_URL || '';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function checkDns(name) {
  try {
    log('DNS resolve', name);
    const records = await dns.resolve4(name);
    log('A records:', records.join(', '));
  } catch (err) {
    log('DNS resolve failed:', err && err.code ? err.code : err.message || err);
  }
}

function checkTcp(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeout);
    socket.once('error', (err) => {
      if (done) return; done = true; socket.destroy(); resolve({ ok: false, err: err.code || err.message });
    });
    socket.once('timeout', () => { if (done) return; done = true; socket.destroy(); resolve({ ok: false, err: 'timeout' }); });
    socket.connect(port, host, () => { if (done) return; done = true; socket.end(); resolve({ ok: true }); });
  });
}

async function testProxyConnect(url) {
  try {
    const m = url.match(/^([^:]+):\/\/([^:@]+)(?::([^@]+))?@?([^:]+):(\d+)/);
    if (!m) {
      log('Proxy URL parsing failed, attempting generic parse:', url);
      // fallback: try to extract host:port with URL
      try {
        const u = new URL(url);
        const host = u.hostname;
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        return await checkTcp(host, port);
      } catch (err) {
        return { ok: false, err: 'parse_fail' };
      }
    }
    const host = m[4];
    const port = Number(m[5]);
    log('Testing TCP to proxy', host + ':' + port);
    return await checkTcp(host, port);
  } catch (err) {
    return { ok: false, err: err && err.message ? err.message : err };
  }
}

async function tryFetchViaProxy(url, proxy) {
  try {
    log('Attempting fetch via undici ProxyAgent (requires undici installed in environment)');
    // dynamic import undici
    const undici = await import('undici');
    const { ProxyAgent, fetch } = undici;
    const agent = new ProxyAgent(proxy);
    const res = await fetch(url, { dispatcher: agent, method: 'GET' });
    log('Fetch status:', res.status);
    const text = await res.text().catch(() => '<body omitted>');
    log('Body snippet:', text.slice(0, 200));
    return { ok: true, status: res.status };
  } catch (err) {
    log('Fetch via proxy failed:', err && err.code ? err.code : err.message || err);
    return { ok: false, err: err && err.message ? err.message : err };
  }
}

async function main() {
  log('Probe target:', PROBE_HOST);
  await checkDns(PROBE_HOST);

  if (proxyUrl) {
    log('AI_PROXY_URL present:', proxyUrl.replace(/\\/\\/([^:]+):([^@]+)@/, '//$1:***@'));
    const tcp = await testProxyConnect(proxyUrl);
    log('Proxy TCP result:', tcp);
    const fetchRes = await tryFetchViaProxy('https://httpbin.org/get', proxyUrl);
    log('Proxy fetch result:', fetchRes);
  } else {
    log('No AI_PROXY_URL set — only DNS check performed');
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
