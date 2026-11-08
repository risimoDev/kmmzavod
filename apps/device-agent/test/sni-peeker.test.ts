import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { parseSni, DeviceProxyListener, isTikTokMediaCdn, isHeavyMediaCdn } from '../src/proxy-forwarder';

const quiet: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

async function testSniParser() {
  // 1. Test parseSni with real TLS ClientHello
  let capturedSni: string | null = null;
  const dummyServer = net.createServer((sock) => {
    sock.once('data', (chunk) => {
      capturedSni = parseSni(chunk);
      sock.destroy();
    });
  });
  dummyServer.listen(0, '127.0.0.1');
  await new Promise((r) => dummyServer.once('listening', r));
  const dummyPort = (dummyServer.address() as net.AddressInfo).port;

  const tlsSock = tls.connect({
    host: '127.0.0.1',
    port: dummyPort,
    servername: 'api16-normal-c-alisg.tiktokv.com',
    rejectUnauthorized: false,
  });
  tlsSock.on('error', () => {});
  await new Promise((r) => tlsSock.once('close', r));
  dummyServer.close();

  assert.strictEqual(capturedSni, 'api16-normal-c-alisg.tiktokv.com', 'SNI parser should correctly extract tiktok domain');
  console.log('PASS parseSni extracts TLS ClientHello SNI accurately');
}

async function testDeviceProxyListenerSniPeeking() {
  // Target: upstream server expecting the peeked hostname
  let upstreamReceivedData = false;
  let receivedHost = '';
  const targetServer = net.createServer((sock) => {
    sock.once('data', (d) => {
      upstreamReceivedData = true;
      sock.write(d); // Echo TLS
    });
  });
  targetServer.listen(0, '127.0.0.1');
  await new Promise((r) => targetServer.once('listening', r));
  const targetPort = (targetServer.address() as net.AddressInfo).port;

  // Mock upstream proxy
  const mockUpstream: any = {
    openTunnel: async (host: string, port: number) => {
      receivedHost = host;
      return net.connect({ host: '127.0.0.1', port: targetPort });
    },
  };

  const listener = new DeviceProxyListener(
    'test-device-1',
    (targetHost) => {
      return { kind: 'proxy', upstream: mockUpstream };
    },
    quiet,
    {
      bindHost: '127.0.0.1',
      idleTimeoutMs: 5000,
    },
  );

  const listenPort = await listener.start(0);

  // Client connects to 127.0.0.1:listenPort with raw IP (like sing-box redirect)
  const clientSock = net.connect({ host: '127.0.0.1', port: listenPort }, () => {
    clientSock.write(`CONNECT 162.159.61.3:443 HTTP/1.1\r\nHost: 162.159.61.3:443\r\n\r\n`);
  });

  await new Promise<void>((resolve, reject) => {
    clientSock.once('data', (resp) => {
      assert(resp.toString().includes('200 Connection Established'), 'Must respond 200 Connection Established');

      // Now client sends TLS ClientHello
      const secureSocket = tls.connect({
        socket: clientSock,
        servername: 'api.tiktokv.com',
        rejectUnauthorized: false,
      });
      secureSocket.on('error', () => {});
      setTimeout(() => {
        assert.strictEqual(receivedHost, 'api.tiktokv.com', 'Upstream proxy must receive peeked SNI instead of raw IP');
        secureSocket.destroy();
        resolve();
      }, 200);
    });
  });

  await listener.stop();
  targetServer.close();
  console.log('PASS DeviceProxyListener successfully peeks SNI and dials upstream with domain name');
}

async function testMediaCdnClassification() {
  // 1. Critical APIs must NEVER be matched as CDN
  assert.strictEqual(isTikTokMediaCdn('api-va.tiktokv.com'), false, 'TikTok API must not be CDN');
  assert.strictEqual(isTikTokMediaCdn('passport.tiktokv.com'), false, 'Passport auth must not be CDN');
  assert.strictEqual(isTikTokMediaCdn('upload-va.tiktokv.com'), false, 'Upload endpoint must not be CDN');
  assert.strictEqual(isTikTokMediaCdn('api-h2.byteoversea.com'), false, 'Byteoversea API must not be CDN');
  assert.strictEqual(isTikTokMediaCdn('tiktok.com'), false, 'tiktok.com must not be CDN');
  assert.strictEqual(isTikTokMediaCdn('www.tiktok.com'), false, 'www.tiktok.com must not be CDN');

  // 2. Heavy video CDN endpoints MUST be classified as CDN
  assert.strictEqual(isTikTokMediaCdn('v16-webapp-prime.tiktokcdn.com'), true, 'Video CDN must be CDN');
  assert.strictEqual(isTikTokMediaCdn('v19.tiktokcdn.com'), true, 'Video CDN must be CDN');
  assert.strictEqual(isTikTokMediaCdn('p16-va.tiktokcdn.com'), true, 'p16 cdn must be CDN');
  assert.strictEqual(isTikTokMediaCdn('sf16-va.tiktokcdn.com'), true, 'sf16 cdn must be CDN');
  assert.strictEqual(isTikTokMediaCdn('obj.ibytedtos.com'), true, 'ByteDance storage must be CDN');
  assert.strictEqual(isTikTokMediaCdn('v26.byteoversea.net'), true, 'Byteoversea net must be CDN');
  assert.strictEqual(isHeavyMediaCdn('v16.tiktokcdn.com'), true, 'Heavy CDN detector must match');
  assert.strictEqual(isHeavyMediaCdn('scontent.cdninstagram.com'), true, 'Instagram CDN must match');

  console.log('PASS isTikTokMediaCdn and isHeavyMediaCdn accurately segregate API vs heavy video CDN');
}

async function main() {
  await testSniParser();
  await testDeviceProxyListenerSniPeeking();
  await testMediaCdnClassification();
  console.log('\nAll SNI peeking and traffic saver tests PASSED successfully!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
