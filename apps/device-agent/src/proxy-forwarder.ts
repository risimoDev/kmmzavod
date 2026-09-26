import http from 'node:http';
import net from 'node:net';
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

  constructor(
    public readonly config: UpstreamProxyConfig,
    private readonly logger: Logger,
  ) {}

  /** Start listening on 127.0.0.1 with an OS-allocated port */
  async start(): Promise<number> {
    if (this.server) return this.boundPort;

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

      // Bind to 127.0.0.1 so only local host and adb reverse can access it
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.boundPort = addr.port;
          this.logger.info(
            { boundPort: this.boundPort, upstream: `${this.config.host}:${this.config.port}` },
            'proxy-forwarder: local proxy started'
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

  /** Handle HTTPS CONNECT tunnel (used for 99%+ of modern Android traffic) */
  private handleConnectTunnel(
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const targetUrl = clientReq.url || '';
    const [targetHost, targetPortStr] = targetUrl.split(':');
    const targetPort = parseInt(targetPortStr, 10) || 443;

    if (this.config.type === 'socks5') {
      this.connectViaSocks5(targetHost, targetPort, clientSocket, head);
    } else {
      this.connectViaHttpProxy(targetUrl, clientSocket, head);
    }
  }

  /** CONNECT via upstream HTTP proxy with Proxy-Authorization header */
  private connectViaHttpProxy(targetUrl: string, clientSocket: net.Socket, head: Buffer): void {
    const upstreamSocket = net.connect(this.config.port, this.config.host, () => {
      let authHeader = '';
      if (this.config.username && this.config.password) {
        const creds = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
        authHeader = `Proxy-Authorization: Basic ${creds}\r\n`;
      }

      const connectPayload =
        `CONNECT ${targetUrl} HTTP/1.1\r\n` +
        `Host: ${targetUrl}\r\n` +
        authHeader +
        `Proxy-Connection: Keep-Alive\r\n\r\n`;

      upstreamSocket.write(connectPayload);

      let handshakeDone = false;
      let buffer = Buffer.alloc(0);

      const onData = (chunk: Buffer) => {
        if (!handshakeDone) {
          buffer = Buffer.concat([buffer, chunk]);
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            handshakeDone = true;
            const headerStr = buffer.subarray(0, headerEnd).toString('utf-8');
            if (headerStr.includes('200')) {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              upstreamSocket.removeListener('data', onData);

              const remainder = buffer.subarray(headerEnd + 4);
              if (remainder.length > 0) {
                clientSocket.write(remainder);
              }
              if (head && head.length > 0) {
                upstreamSocket.write(head);
              }

              upstreamSocket.pipe(clientSocket);
              clientSocket.pipe(upstreamSocket);
            } else {
              clientSocket.write(headerStr + '\r\n\r\n');
              clientSocket.end();
              upstreamSocket.end();
            }
          }
        }
      };

      upstreamSocket.on('data', onData);
    });

    upstreamSocket.on('error', (err) => {
      this.logger.debug({ err: err.message, targetUrl }, 'proxy-forwarder: upstream HTTP CONNECT error');
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      }
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });
  }

  /** CONNECT via upstream SOCKS5 proxy with RFC 1928 / 1929 authentication */
  private connectViaSocks5(targetHost: string, targetPort: number, clientSocket: net.Socket, head: Buffer): void {
    const upstreamSocket = net.connect(this.config.port, this.config.host, () => {
      // Send SOCKS5 Greeting: support both NO_AUTH (0x00) and USER_PASS (0x02)
      upstreamSocket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });

    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';

    upstreamSocket.on('data', (data: Buffer) => {
      if (stage === 'greeting') {
        if (data[0] !== 0x05) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
          return;
        }

        const method = data[1];
        if (method === 0x02) {
          // Username/Password authentication requested
          stage = 'auth';
          const u = Buffer.from(this.config.username || '');
          const p = Buffer.from(this.config.password || '');
          const authBuf = Buffer.concat([
            Buffer.from([0x01, u.length]),
            u,
            Buffer.from([p.length]),
            p,
          ]);
          upstreamSocket.write(authBuf);
        } else if (method === 0x00) {
          // No auth needed
          stage = 'connect';
          this.sendSocks5Connect(upstreamSocket, targetHost, targetPort);
        } else {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
        }
      } else if (stage === 'auth') {
        if (data[1] === 0x00) {
          stage = 'connect';
          this.sendSocks5Connect(upstreamSocket, targetHost, targetPort);
        } else {
          this.logger.warn({ targetHost, targetPort }, 'proxy-forwarder: SOCKS5 auth failed');
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
        }
      } else if (stage === 'connect') {
        if (data[1] === 0x00) {
          // SOCKS5 tunnel established! Tell Android client HTTP 200 OK
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstreamSocket.removeAllListeners('data');

          if (head && head.length > 0) {
            upstreamSocket.write(head);
          }

          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);
        } else {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
        }
      }
    });

    upstreamSocket.on('error', (err) => {
      this.logger.debug({ err: err.message, targetHost, targetPort }, 'proxy-forwarder: upstream SOCKS5 CONNECT error');
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      }
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });
  }

  private sendSocks5Connect(socket: net.Socket, host: string, port: number): void {
    const hostBuf = Buffer.from(host);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port, 0);

    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      portBuf,
    ]);
    socket.write(req);
  }

  /** Handle plain HTTP requests (GET, POST, etc.) */
  private handleHttpRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    let authHeader: string | undefined;
    if (this.config.username && this.config.password) {
      const creds = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      authHeader = `Basic ${creds}`;
    }

    const options: http.RequestOptions = {
      hostname: this.config.host,
      port: this.config.port,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        ...(authHeader ? { 'proxy-authorization': authHeader } : {}),
      },
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
