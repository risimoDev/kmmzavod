import http from 'node:http';
import net from 'node:net';
import { SocksClient } from 'socks';
import type { Logger } from 'pino';

export interface UpstreamProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type?: 'http' | 'https' | 'socks5' | 'residential' | 'mobile';
}

/**
 * LocalProxyForwarder creates an unauthenticated local HTTP proxy on the Farm PC.
 *
 * Android OS does not natively support username/password authentication for global HTTP proxies
 * via `settings put global http_proxy`.
 *
 * By running this local forwarder and executing:
 *   adb reverse tcp:8888 tcp:<forwarderPort>
 *   settings put global http_proxy 127.0.0.1:8888
 *
 * All Android apps (Chrome, Instagram, TikTok, OS services) send unauthenticated traffic
 * to 127.0.0.1:8888 over the USB cable. This forwarder injects the upstream credentials
 * (HTTP Basic Auth or SOCKS5 RFC 1928/1929) and transparently pipes traffic to the upstream proxy.
 */
export class LocalProxyForwarder {
  private server: http.Server | null = null;
  private activeSockets = new Set<net.Socket>();
  public boundPort = 0;
  public effectiveType: 'http' | 'socks5' = 'http';

  constructor(
    public readonly config: UpstreamProxyConfig,
    private readonly logger: Logger,
  ) {}

  /** Start listening on 127.0.0.1 with an OS-allocated port */
  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    // Detect actual protocol: if specified as socks5, use it; otherwise probe whether port speaks SOCKS5 or HTTP
    if (this.config.type === 'socks5') {
      this.effectiveType = 'socks5';
    } else {
      this.effectiveType = await this.probeProtocol();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((clientReq, clientRes) => {
        this.handleHttpRequest(clientReq, clientRes);
      });

      this.server.on('connect', (clientReq, clientSocket, head) => {
        this.handleConnectTunnel(clientReq, clientSocket as net.Socket, head);
      });

      this.server.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.once('close', () => this.activeSockets.delete(socket));
      });

      this.server.on('error', (err) => {
        this.logger.error({ err: err.message, config: this.config }, 'proxy-forwarder: server error');
      });

      // Bind to 0.0.0.0 so both adb reverse (127.0.0.1) and Gnirehtet VPN (10.0.0.1) can reach it
      this.server.listen(0, '0.0.0.0', () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.boundPort = addr.port;
          this.logger.info(
            {
              boundPort: this.boundPort,
              upstream: `${this.config.host}:${this.config.port}`,
              protocol: this.effectiveType,
            },
            'proxy-forwarder: local proxy started (listening on 0.0.0.0 for adb reverse & gnirehtet)'
          );
          resolve(this.boundPort);
        } else {
          reject(new Error('Could not determine local forwarder bound port'));
        }
      });
    });
  }

  /** Stop the forwarder and destroy all active connections */
  async stop(): Promise<void> {
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
      this.boundPort = 0;
      this.logger.info('proxy-forwarder: local proxy stopped');
    }
  }

  /**
   * Fast probe to verify if upstream proxy speaks SOCKS5 or HTTP.
   * Sends SOCKS5 greeting [0x05, 0x01, 0x00]. If reply starts with 0x05, it's SOCKS5.
   */
  private async probeProtocol(): Promise<'http' | 'socks5'> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (proto: 'http' | 'socks5') => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(proto);
        }
      };

      const socket = net.connect(this.config.port, this.config.host, () => {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      socket.setTimeout(2500);
      socket.once('data', (chunk) => {
        if (chunk.length > 0 && chunk[0] === 0x05) {
          this.logger.info(
            { upstream: `${this.config.host}:${this.config.port}` },
            'proxy-forwarder: detected upstream proxy protocol: SOCKS5'
          );
          done('socks5');
        } else {
          this.logger.info(
            { upstream: `${this.config.host}:${this.config.port}` },
            'proxy-forwarder: detected upstream proxy protocol: HTTP'
          );
          done('http');
        }
      });

      socket.once('error', () => done(this.config.type === 'socks5' ? 'socks5' : 'http'));
      socket.once('timeout', () => done(this.config.type === 'socks5' ? 'socks5' : 'http'));
    });
  }

  /** Handle HTTPS CONNECT tunnel (used for 99%+ of modern Android traffic) */
  private handleConnectTunnel(
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const targetUrl = clientReq.url || '';
    const [targetHost, targetPortStr] = targetUrl.split(':');
    const targetPort = parseInt(targetPortStr, 10) || 443;

    if (this.effectiveType === 'socks5') {
      this.connectViaSocks5(targetHost, targetPort, clientSocket, head);
    } else {
      this.connectViaHttpProxy(targetHost, targetPort, clientSocket, head);
    }
  }

  /** CONNECT via upstream HTTP proxy with Proxy-Authorization header */
  private connectViaHttpProxy(
    targetHost: string,
    targetPort: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const upstreamSocket = net.connect(this.config.port, this.config.host, () => {
      let authHeader = '';
      if (this.config.username && this.config.password) {
        const creds = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
        authHeader = `Proxy-Authorization: Basic ${creds}\r\n`;
      }

      const connectPayload =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `User-Agent: Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36\r\n` +
        `Proxy-Connection: Keep-Alive\r\n` +
        `Connection: Keep-Alive\r\n` +
        authHeader +
        `\r\n`;

      upstreamSocket.write(connectPayload);

      let handshakeDone = false;
      let buffer = Buffer.alloc(0);

      const onData = (chunk: Buffer) => {
        if (!handshakeDone) {
          buffer = Buffer.concat([buffer, chunk]);
          const headerEnd = buffer.indexOf('\r\n\r\n');
          const headerEndAlt = headerEnd === -1 ? buffer.indexOf('\n\n') : headerEnd;
          const delimLen = headerEnd !== -1 ? 4 : 2;

          if (headerEndAlt !== -1) {
            handshakeDone = true;
            upstreamSocket.removeListener('data', onData);
            const headerStr = buffer.subarray(0, headerEndAlt).toString('ascii');
            const firstLine = headerStr.split(/\r?\n/)[0] || '';
            const match = firstLine.match(/^HTTP\/1\.[01]\s+(\d{3})/i);
            const statusCode = match ? parseInt(match[1], 10) : 0;

            if (statusCode === 200) {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

              const remainder = buffer.subarray(headerEndAlt + delimLen);
              if (remainder.length > 0) {
                clientSocket.write(remainder);
              }
              if (head && head.length > 0) {
                upstreamSocket.write(head);
              }

              upstreamSocket.pipe(clientSocket);
              clientSocket.pipe(upstreamSocket);
            } else {
              this.logger.warn(
                { targetHost, targetPort, statusCode, firstLine },
                'proxy-forwarder: upstream HTTP proxy rejected CONNECT'
              );
              // Cleanly respond with 502 Bad Gateway to the Android client
              if (!clientSocket.destroyed) {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                clientSocket.end();
              }
              upstreamSocket.destroy();
            }
          }
        }
      };

      upstreamSocket.on('data', onData);
    });

    upstreamSocket.setTimeout(15_000);
    upstreamSocket.on('timeout', () => {
      upstreamSocket.destroy(new Error('Upstream HTTP proxy timeout (15s)'));
    });

    upstreamSocket.on('error', (err) => {
      this.logger.debug({ err: err.message, targetHost, targetPort }, 'proxy-forwarder: upstream HTTP CONNECT error');
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      }
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });
  }

  /** CONNECT via upstream SOCKS5 proxy using robust SocksClient */
  private connectViaSocks5(
    targetHost: string,
    targetPort: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    SocksClient.createConnection({
      proxy: {
        host: this.config.host,
        port: this.config.port,
        type: 5,
        userId: this.config.username,
        password: this.config.password,
      },
      command: 'connect',
      destination: {
        host: targetHost,
        port: targetPort,
      },
      timeout: 15_000,
    })
      .then((info) => {
        if (clientSocket.destroyed) {
          info.socket.destroy();
          return;
        }

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        if (head && head.length > 0) {
          info.socket.write(head);
        }

        info.socket.pipe(clientSocket);
        clientSocket.pipe(info.socket);

        info.socket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => info.socket.destroy());
      })
      .catch((err) => {
        this.logger.debug({ err: err.message, targetHost, targetPort }, 'proxy-forwarder: upstream SOCKS5 CONNECT error');
        if (!clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
        }
      });
  }

  /** Handle plain HTTP requests (GET, POST, etc.) */
  private handleHttpRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const rawUrl = clientReq.url || '/';
    const hostHeader = (clientReq.headers.host || '').split(':')[0] || this.config.host;

    let targetPath = rawUrl;
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      targetPath = `http://${hostHeader}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    }

    if (this.effectiveType === 'socks5') {
      SocksClient.createConnection({
        proxy: {
          host: this.config.host,
          port: this.config.port,
          type: 5,
          userId: this.config.username,
          password: this.config.password,
        },
        command: 'connect',
        destination: {
          host: hostHeader,
          port: 80,
        },
        timeout: 15_000,
      })
        .then((info) => {
          let reqLine = `${clientReq.method} ${clientReq.url || '/'} HTTP/1.1\r\n`;
          let headers = '';
          for (const [k, v] of Object.entries(clientReq.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              v.forEach((val) => {
                headers += `${k}: ${val}\r\n`;
              });
            } else {
              headers += `${k}: ${v}\r\n`;
            }
          }
          info.socket.write(reqLine + headers + '\r\n');
          clientReq.pipe(info.socket);

          info.socket.pipe(clientRes.socket as net.Socket);
        })
        .catch((err) => {
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          clientRes.end(`Upstream SOCKS5 error: ${err.message}`);
        });
      return;
    }

    let authHeader: string | undefined;
    if (this.config.username && this.config.password) {
      const creds = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      authHeader = `Basic ${creds}`;
    }

    const options: http.RequestOptions = {
      hostname: this.config.host,
      port: this.config.port,
      path: targetPath,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        ...(authHeader ? { 'proxy-authorization': authHeader } : {}),
      },
      timeout: 15_000,
    };

    const upstreamReq = http.request(options, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      clientRes.end(`Upstream proxy error: ${err.message}`);
    });

    clientReq.pipe(upstreamReq);
  }
}
