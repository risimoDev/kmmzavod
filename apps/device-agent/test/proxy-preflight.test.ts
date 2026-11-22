import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProxyManager } from '../src/proxy-manager';
import { config } from '../src/config';

test('transparent IP check neither falls back to the explicit proxy nor accepts an IP in an error', async () => {
  const commands: string[] = [];
  const manager = Object.assign(Object.create(ProxyManager.prototype) as ProxyManager, {
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
  });

  const check = await manager.checkDeviceIp('board');
  assert.equal(check.ok, false);
  assert.equal(check.ip, undefined);
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command.includes("--noproxy '*'") && !command.includes(' -x ')));
});

test('publication requires transparent routing in auto mode and a known farm IP', async () => {
  const previousMode = config.PROXY_ROOT_MODE;
  config.PROXY_ROOT_MODE = 'auto';
  try {
    const check = {
      ok: true, ip: '198.51.100.2', leakDetected: false, exposesHostIp: false,
      route: 'proxy' as const, method: 'system_proxy' as 'system_proxy' | 'transparent', hostIp: '192.0.2.1',
    };
    const manager = Object.assign(Object.create(ProxyManager.prototype) as ProxyManager, {
      devices: new Map([['board', {}]]),
      hasAnyProxy: () => true,
      ensureDeviceInternet: async () => check,
    });

    assert.equal((await manager.preflight('board')).ok, false);
    check.method = 'transparent';
    assert.equal((await manager.preflight('board')).ok, true);
    check.hostIp = '';
    assert.equal((await manager.preflight('board')).ok, false);
  } finally {
    config.PROXY_ROOT_MODE = previousMode;
  }
});
