import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import pino from 'pino';
import { DeviceProxyListener } from '../src/proxy-forwarder';

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

async function testHalfClose(gatewayPort: number, targetPort: number): Promise<void> {
  const client = net.connect({ host: '127.0.0.1', port: gatewayPort });
  let response = '';
  let accepted = false;
  try {
    client.setTimeout(4_000, () => client.destroy(new Error('Tunnel timed out')));
    client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
    for await (const chunk of client) {
      response += chunk.toString();
      if (accepted) continue;
      const headersEnd = response.indexOf('\r\n\r\n');
      if (headersEnd < 0) continue;
      assert.match(response, /^HTTP\/1\.1 200 /);
      response = response.slice(headersEnd + 4);
      accepted = true;
      client.end('request');
    }
    assert.equal(response, 'response: request');
  } finally {
    client.destroy();
  }
}

async function testUpstreamHalfClose(gatewayPort: number): Promise<void> {
  let complete: (value: string) => void;
  const received = new Promise<string>((resolve) => { complete = resolve; });
  const target = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = '';
    socket.on('data', (chunk) => { request += chunk.toString(); });
    socket.on('end', () => complete(request));
    socket.end('challenge');
  });
  const targetPort = await listen(target);
  const client = net.connect({ host: '127.0.0.1', port: gatewayPort, allowHalfOpen: true });
  try {
    client.setTimeout(4_000, () => client.destroy(new Error('Tunnel timed out')));
    let response = '';
    client.on('data', (chunk) => { response += chunk.toString(); });
    client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
    await once(client, 'end');
    assert.match(response, /\r\n\r\nchallenge$/);
    await new Promise((done) => setTimeout(done, 100));
    client.end('ack');
    assert.equal(await received, 'ack');
  } finally {
    client.destroy();
    target.close();
  }
}

async function main(): Promise<void> {
  const target = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = '';
    socket.on('data', (chunk) => { request += chunk.toString(); });
    socket.on('end', () => {
      setTimeout(() => socket.end(`response: ${request}`), 100);
    });
  });
  const targetPort = await listen(target);
  const gateway = new DeviceProxyListener(
    'test-board',
    () => ({ kind: 'direct' }),
    pino({ enabled: false }),
    { bindHost: '127.0.0.1', idleTimeoutMs: 5_000 },
  );
  try {
    await testHalfClose(await gateway.start(), targetPort);
    console.log('PASS board gateway forwards a response after client FIN');
    await testUpstreamHalfClose(gateway.port);
    console.log('PASS board gateway forwards client data after upstream FIN');

    const relayPath = 'infra/proxy-relay/relay.mjs';
    const relay = spawn(process.execPath, [existsSync(relayPath) ? relayPath : `../../${relayPath}`], {
      env: { ...process.env, RELAY_LISTEN: '127.0.0.1:0', RELAY_ALLOW: '127.0.0.1/32' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    const lines = createInterface(relay.stdout);
    const exited = once(relay, 'exit');
    try {
      const relayPort = await Promise.race([
        once(lines, 'line').then(([line]) => {
          const match = /listening on 127\.0\.0\.1:(\d+)/.exec(line);
          assert.ok(match, line);
          return Number(match[1]);
        }),
        exited.then(([code]) => { throw new Error(`Relay exited before listening (${code})`); }),
      ]);
      await testHalfClose(relayPort, targetPort);
      await testUpstreamHalfClose(relayPort);
      console.log('PASS VPS relay preserves both TCP directions after FIN');
    } finally {
      lines.close();
      relay.kill();
      await exited;
    }
  } finally {
    await gateway.stop();
    target.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
