import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProxyManager } from '../src/proxy-manager';
import { config } from '../src/config';

test('private publication keeps the assigned routes and fails closed without rotating or switching', async () => {
  const previousRelay = config.PROXY_UPSTREAM_VIA;
  config.PROXY_UPSTREAM_VIA = '';
  try {
    const first = { host: '198.51.100.1', port: 1080, type: 'socks5', rotateUrl: 'https://example.test/rotate' };
    const second = { host: '198.51.100.2', port: 8080, type: 'http' };
    const failedCheck = { ok: false, route: 'proxy', code: 'timeout' };
    const manager = Object.assign(Object.create(ProxyManager.prototype), {
      mode: 'private_parallel', activeDeviceId: 'second', inactivePolicy: 'direct',
      devices: new Map([['first', { proxy: first }], ['second', { proxy: second }]]),
      publishTraffic: new Map(),
      getUpstream: (proxy: unknown) => proxy,
      checkDeviceIp: async () => failedCheck,
    }) as ProxyManager;

    const release = await manager.acquireTaskLease('first');
    assert.deepEqual(manager['routeFor']('first'), { kind: 'proxy', upstream: first });
    assert.deepEqual(manager['routeFor']('second'), { kind: 'proxy', upstream: second });
    assert.equal(await manager.ensureDeviceInternet('first'), failedCheck);
    await assert.rejects(manager.switchActiveDevice('first', { force: true }), /Shared Sequential/);
    assert.equal(manager.activeDeviceId, 'second');
    release();

    assert.equal(manager['routeFor']('unconfigured', 'api.example.test').kind, 'block');
    assert.equal((await manager.preflight('unconfigured')).ok, false);
    manager.trafficStandby = true;
    assert.equal(manager['routeFor']('first', 'api.example.test').kind, 'block');
  } finally {
    config.PROXY_UPSTREAM_VIA = previousRelay;
  }
});

test('transparent IP check neither falls back to the explicit proxy nor accepts an IP in an error', async () => {
  const commands: string[] = [];
  const manager = Object.assign(Object.create(ProxyManager.prototype), {
    devices: new Map([['board', {}]]),
    runtimes: new Map([['board', { method: 'transparent' }]]),
    listeners: new Map(),
    routeKind: () => 'proxy',
    refreshHostIp: async () => '192.0.2.1',
    probeGateway: async () => ({ ok: true, systemProxyOk: true }),
    adb: {
      shell: async (_id: string, command: string) => {
        commands.push(command);
        return command.includes(' -x ') ? '198.51.100.2' : 'curl: failed to connect to 192.0.2.21';
      },
    },
  }) as ProxyManager;

  const check = await manager.checkDeviceIp('board');
  assert.equal(check.ok, false);
  assert.equal(check.ip, undefined);
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command.includes("--noproxy '*'") && !command.includes(' -x ')));
});

test('transparent IP check reads HTTP netcat bodies with Android newline variants and still detects leaks', async () => {
  const hostIp = '192.0.2.11';
  const responses = (ip: string, newline: string, status = '200 OK') =>
    [`HTTP/1.0 ${status}`, `Content-Length: ${ip.length}`, 'Content-Type: text/plain', 'Via: 1.1 google', '', ip].join(newline);
  let output = responses('177.177.149.209', '\r\r\n');
  const commands: string[] = [];
  const manager = Object.assign(Object.create(ProxyManager.prototype), {
    mode: 'private_parallel', devices: new Map([['board', {}]]),
    runtimes: new Map([['board', { method: 'transparent' }]]), listeners: new Map(),
    routeKind: () => 'proxy', refreshHostIp: async () => hostIp,
    probeGateway: async () => ({ ok: true, systemProxyOk: true }),
    logger: { warn() {} }, geo: async () => ({}), root: { isRunning: async () => true },
    ensureDeviceInternet: () => manager.checkDeviceIp('board'),
    adb: { shell: async (_id: string, command: string) => { commands.push(command); return output; } },
  }) as ProxyManager;

  assert.equal((await manager.preflight('board')).ipCheck?.ip, '177.177.149.209');
  assert.match(commands[0], /toybox nc .*\| tr -d/);
  assert.doesNotMatch(commands[0], / -x /);
  output = responses('179.66.209.25', '\r\n');
  const second = await manager.preflight('board');
  assert.equal(second.ok, true);
  assert.equal(second.ipCheck?.ip, '179.66.209.25');
  output = responses(hostIp, '\n');
  const leak = await manager.preflight('board');
  assert.equal(leak.ok, false);
  assert.equal(leak.ipCheck?.leakDetected, true);
  output = responses('179.66.209.25', '\r\r\n', '403 Forbidden');
  assert.equal((await manager.preflight('board')).ok, false);
  output = 'HTTP/1.0 200 OK\r\nX-Forwarded-For: 179.66.209.25\r\n\r\n';
  assert.equal((await manager.preflight('board')).ok, false);
});

test('publication requires transparent routing in auto mode and a known farm IP', async () => {
  const previousMode = config.PROXY_ROOT_MODE;
  config.PROXY_ROOT_MODE = 'auto';
  try {
    const check = {
      ok: true, ip: '198.51.100.2', leakDetected: false, exposesHostIp: false,
      route: 'proxy' as const, method: 'system_proxy' as 'system_proxy' | 'transparent', hostIp: '192.0.2.1',
    };
    const manager = Object.assign(Object.create(ProxyManager.prototype), {
      devices: new Map([['board', {}]]),
      hasAnyProxy: () => true,
      ensureDeviceInternet: async () => check,
    }) as ProxyManager;

    assert.equal((await manager.preflight('board')).ok, false);
    check.method = 'transparent';
    assert.equal((await manager.preflight('board')).ok, true);
    check.hostIp = '';
    assert.equal((await manager.preflight('board')).ok, false);
  } finally {
    config.PROXY_ROOT_MODE = previousMode;
  }
});

test('transparent-only mode clears the system proxy on the selected board once its firewall is confirmed', async () => {
  const serial = 'test-transparent-only';
  const previousDns = config.PROXY_DNS_VIA;
  const previousRootMode = config.PROXY_ROOT_MODE;
  config.PROXY_DNS_VIA = '10.66.66.1';
  config.PROXY_ROOT_MODE = 'auto';
  config.PROXY_TRANSPARENT_ONLY_DEVICES.add(serial);
  try {
    const settings = new Map<string, string>();
    const listener = { port: 18800 };
    const entry = { proxy: { host: '192.0.2.1', port: 1080, type: 'socks5' } };
    let firewallReady = false;
    const manager = Object.assign(Object.create(ProxyManager.prototype), {
      devices: new Map([[serial, entry], ['standard-board', entry]]),
      runtimes: new Map(),
      upstreams: new Map(),
      listeners: new Map([[serial, listener], ['standard-board', listener]]),
      routeKind: () => 'proxy',
      withDeviceLock: async (_id: string, action: () => Promise<void>) => action(),
      ensureListener: async () => listener,
      logger: { info() {}, warn() {} },
      root: {
        isRooted: async () => true,
        start: async () => {},
        isRunning: async () => firewallReady,
      },
      adb: {
        exec: async () => `tcp:${config.PROXY_DEVICE_PORT} tcp:${listener.port}`,
        shell: async (id: string, command: string) => {
          if (command.startsWith('echo "__PROXY=')) {
            return id === serial
              ? '__PROXY=null\r\n__PROXY_HOST=null\r\n'
              : `__PROXY=127.0.0.1:${config.PROXY_DEVICE_PORT}\r\n`;
          }
          settings.set(id, command);
          return '';
        },
      },
    }) as ProxyManager;

    await assert.rejects(manager.reapplyDevice(serial), /без подтверждённого прозрачного маршрута/);
    assert.equal(settings.has(serial), false);
    firewallReady = true;
    await manager.reapplyDevice(serial);
    await manager.reapplyDevice('standard-board');
    assert.match(settings.get(serial) ?? '', /settings delete global global_http_proxy_host/);
    assert.match(settings.get('standard-board') ?? '', /settings put global http_proxy 127\.0\.0\.1:/);
    assert.equal(await manager['isWiringHealthy'](serial), true);
    assert.equal(await manager['isWiringHealthy']('standard-board'), true);
  } finally {
    config.PROXY_TRANSPARENT_ONLY_DEVICES.delete(serial);
    config.PROXY_DNS_VIA = previousDns;
    config.PROXY_ROOT_MODE = previousRootMode;
  }
});
