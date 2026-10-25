/**
 * The gateway rides out a mobile proxy's IP-switch window: the upstream refuses CONNECT
 * with 403 for a few seconds (seen on the farm every ~2 min) and then works again.
 */
import http from 'node:http';
import net from 'node:net';
import { UpstreamProxy } from '../src/proxy-forwarder';

let failed = 0;
const ok = (c: boolean, m: string) => { if (!c) failed++; console.log(c ? 'PASS' : 'FAIL', m); };
const quiet: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

async function main() {
  // Target: a TCP echo server standing in for tiktokv.com:443.
  const target = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const targetPort = (target.address() as net.AddressInfo).port;

  // Upstream HTTP proxy: 403 on CONNECT until `refuseUntil`, then a real tunnel.
  let refuseUntil = 0;
  let refusals = 0;
  const proxy = http.createServer();
  proxy.on('connect', (req, client) => {
    if (Date.now() < refuseUntil) {
      refusals++;
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = String(req.url).split(':');
    const up = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise((r) => proxy.once('listening', r));
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  const echo = async (sock: net.Socket) => {
    sock.resume();
    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    sock.write('ping');
    const v = await got;
    sock.destroy();
    return v;
  };
  const mk = (retryWindowMs: number) =>
    new UpstreamProxy({ host: '127.0.0.1', port: proxyPort, type: 'http' }, quiet, { maxConnections: 0, retryWindowMs });

  // 1. 403 for 6 s (an IP switch) → the connection waits and succeeds.
  refuseUntil = Date.now() + 6_000;
  let t0 = Date.now();
  try {
    const v = await echo(await mk(25_000).openTunnel('127.0.0.1', targetPort));
    ok(v === 'ping', `403 window of 6 s ridden out: connected after ${((Date.now() - t0) / 1000).toFixed(1)} s, ${refusals} refusals absorbed`);
  } catch (e) {
    ok(false, `403 window should be ridden out, got: ${(e as Error).message}`);
  }

  // 2. Proxy refuses longer than the window → a clear 403 error, not a hang.
  refusals = 0;
  refuseUntil = Date.now() + 60_000;
  t0 = Date.now();
  try {
    await mk(3_000).openTunnel('127.0.0.1', targetPort);
    ok(false, 'should fail when the proxy refuses longer than the window');
  } catch (e) {
    const s = (Date.now() - t0) / 1000;
    ok(/403/.test((e as Error).message) && s < 6, `refusal beyond the window → 403 error after ${s.toFixed(1)} s (${refusals} tries)`);
  }

  // 3. Healthy proxy → immediate.
  refuseUntil = 0;
  t0 = Date.now();
  const v3 = await echo(await mk(25_000).openTunnel('127.0.0.1', targetPort));
  ok(v3 === 'ping' && Date.now() - t0 < 1_500, 'healthy proxy connects immediately');

  proxy.close();
  target.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
}

void main();
