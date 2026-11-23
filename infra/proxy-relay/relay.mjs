/**
 * Farm proxy relay — runs on the production server (outside the farm's country).
 *
 * The farm PC's ISP (DPI) blocks Instagram/Facebook/TikTok by looking at the plain-text
 * `CONNECT host` line and the TLS SNI of connections to the mobile proxy. The device-agent
 * therefore dials every mobile proxy THROUGH this relay over the AmneziaWG tunnel
 * (DEVICE_AGENT_UPSTREAM_VIA=http://10.66.66.1:3129): the ISP only sees encrypted tunnel
 * traffic, and the sites still see the mobile proxy's IP.
 *
 * Minimal HTTP CONNECT relay, zero dependencies. Only clients from RELAY_ALLOW subnets
 * (the tunnel) are served.
 *
 *   RELAY_LISTEN  host:port to bind (default 10.66.66.1:3129 — the server's tunnel IP)
 *   RELAY_ALLOW   comma-separated IPv4 CIDRs allowed to connect (default 10.66.66.0/24,10.13.13.0/24)
 */
import http from 'node:http';
import net from 'node:net';

const [listenHost, listenPortRaw] = (process.env.RELAY_LISTEN || '10.66.66.1:3129').split(':');
const listenPort = Number(listenPortRaw || 3129);
const allow = (process.env.RELAY_ALLOW || '10.66.66.0/24,10.13.13.0/24')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((cidr) => {
    const [ip, bits = '32'] = cidr.split('/');
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return { net: ipToInt(ip) & mask, mask };
  });

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
}

function allowed(remote) {
  const ip = (remote || '').replace(/^::ffff:/, '');
  if (!net.isIPv4(ip)) return false;
  const n = ipToInt(ip);
  return allow.some((a) => ((n & a.mask) >>> 0) === a.net);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
let active = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, active }));
    return;
  }
  res.writeHead(405);
  res.end('CONNECT only\n');
});

server.on('connect', (req, client, head) => {
  client.on('error', () => {});
  client.setKeepAlive(true, 15_000);
  const reject = (status, reason) => {
    client.end(`HTTP/1.1 ${status}\r\nX-Relay-Error: ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  if (!allowed(client.remoteAddress)) {
    log('denied', client.remoteAddress, req.url);
    reject('403 Forbidden', 'relay_access_denied');
    return;
  }
  const m = /^(?:\[([a-f0-9:.]+)\]|([a-z0-9._-]+)):(\d+)$/i.exec(req.url || '');
  const port = Number(m?.[3]);
  if (!m || (m[1] && !net.isIPv6(m[1])) || port < 1 || port > 65535) {
    reject('400 Bad Request', 'invalid_connect_target');
    return;
  }
  const upstream = net.connect({ host: m[1] || m[2], port });
  upstream.setKeepAlive(true, 15_000);
  let established = false;
  upstream.setTimeout(15_000, () => upstream.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })));
  upstream.once('connect', () => {
    upstream.setTimeout(0);
    established = true;
    active++;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    if (established) {
      established = false;
      active--;
    }
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', (err) => {
    if (!established && !client.destroyed) {
      const timeout = err.code === 'ETIMEDOUT';
      reject(timeout ? '504 Gateway Timeout' : '502 Bad Gateway', timeout ? 'upstream_connect_timeout' : 'upstream_connect_failed');
      return;
    }
    close();
  });
  upstream.on('close', () => { if (established) close(); });
  client.on('close', close);
});

server.on('error', (err) => {
  log('fatal', err.message, '- is the AmneziaWG interface up?');
  process.exit(1);
});

server.listen(listenPort, listenHost, () => log(`farm proxy relay listening on ${listenHost}:${listenPort}, allow=${process.env.RELAY_ALLOW || '10.66.66.0/24,10.13.13.0/24'}`));
