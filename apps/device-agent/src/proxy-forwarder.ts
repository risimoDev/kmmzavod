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
 *
 * Zero external npm dependencies: uses 100% native Node.js standard libraries (net, http).
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

    // Detect actual protocol: if explicitly socks5, use socks5;
    // if explicitly http/mobile/residential, use http immediately; otherwise probe.
    if (this.config.type === 'socks5') {
      this.effectiveType = 'socks5';
    } else if (this.config.type === 'http' || this.config.type === 'mobile' || this.config.type === 'residential') {
      this.effectiveType = 'http';
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
      const done = (proto: 'http' | 'socks5', detail: string) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          this.logger.info(
            { upstream: `${this.config.host}:${this.config.port}`, protocol: proto, detail },
            'proxy-forwarder: upstream protocol determined'
          );
          resolve(proto);
        }
      };

      const socket = net.connect(this.config.port, this.config.host, () => {
        // Send SOCKS5 greeting offering both NO_AUTH (0x00) and USER_PASS (0x02)
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      });

      socket.setTimeout(2500);
      socket.once('data', (chunk) => {
        // Any SOCKS5 proxy responds with [0x05, <method>] (e.g. 05 00, 05 02, or 05 FF)
        if (chunk.length > 0 && chunk[0] === 0x05) {
          done('socks5', `SOCKS5 handshake header: 0x${chunk.toString('hex')}`);
        } else if (chunk.toString().startsWith('HTTP/')) {
          done('http', `HTTP response header: ${chunk.toString().slice(0, 30).trim()}`);
        } else {
          done(this.config.type === 'socks5' ? 'socks5' : 'http', `Non-standard response: 0x${chunk.toString('hex')}`);
        }
      });

      socket.once('error', (err) => {
        done(this.config.type === 'socks5' ? 'socks5' : 'http', `Socket error during probe: ${err.message}`);
      });
      socket.once('timeout', () => {
        done(this.config.type === 'socks5' ? 'socks5' : 'http', 'Socket timeout during probe');
      });
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
        `Proxy-Connection: Keep-Alive\r\n` +
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

              // Reset to 60s idle timeout for active tunnel
              upstreamSocket.setTimeout(60_000);

              upstreamSocket.pipe(clientSocket);
              clientSocket.pipe(upstreamSocket);

              clientSocket.once('close', () => {
                upstreamSocket.destroy();
              });
              upstreamSocket.once('close', () => {
                clientSocket.destroy();
              });
            } else {
              const locationMatch = headerStr.match(/location:\s*([^\r\n]+)/i);
              const location = locationMatch ? locationMatch[1].trim() : undefined;
              this.logger.warn(
                { targetHost, targetPort, statusCode, firstLine, location },
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

  /**
   * CONNECT via upstream SOCKS5 proxy using 100% native Node.js net.Socket RFC 1928 / 1929 implementation.
   * Completely self-contained: zero external dependencies.
   */
  private connectViaSocks5(
    targetHost: string,
    targetPort: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const upstreamSocket = net.connect(this.config.port, this.config.host, () => {
      // Send greeting: support NO_AUTH (0x00) and USER_PASS (0x02)
      upstreamSocket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });

    upstreamSocket.setTimeout(15_000);
    upstreamSocket.on('timeout', () => {
      upstreamSocket.destroy(new Error('Upstream SOCKS5 timeout (15s)'));
    });

    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
    let buffer = Buffer.alloc(0);

    const sendConnect = () => {
      const isIp = net.isIP(targetHost);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);

      if (isIp === 4) {
        const parts = targetHost.split('.').map(Number);
        upstreamSocket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts]), portBuf]));
      } else if (isIp === 6) {
        const ipBuf = Buffer.alloc(16);
        upstreamSocket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), ipBuf, portBuf]));
      } else {
        const domBuf = Buffer.from(targetHost);
        upstreamSocket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domBuf.length]), domBuf, portBuf]));
      }
    };

    upstreamSocket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) {
          this.logger.warn({ b0: buffer[0] }, 'proxy-forwarder: invalid SOCKS5 greeting version');
          if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
          return;
        }

        const method = buffer[1];
        buffer = buffer.subarray(2);

        if (method === 0x02) {
          // Username/Password authentication requested
          stage = 'auth';
          const u = Buffer.from(this.config.username || '');
          const p = Buffer.from(this.config.password || '');
          upstreamSocket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        } else if (method === 0x00) {
          // No auth needed
          stage = 'connect';
          sendConnect();
        } else {
          this.logger.warn({ method }, 'proxy-forwarder: SOCKS5 server rejected auth methods');
          if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
          return;
        }
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        if (buffer[1] !== 0x00) {
          this.logger.warn({ authStatus: buffer[1] }, 'proxy-forwarder: SOCKS5 username/password auth failed');
          if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
          return;
        }
        buffer = buffer.subarray(2);
        stage = 'connect';
        sendConnect();
      }

      if (stage === 'connect') {
        if (buffer.length < 4) return;
        if (buffer[1] !== 0x00) {
          this.logger.warn({ rep: buffer[1], targetHost, targetPort }, 'proxy-forwarder: SOCKS5 connect failed');
          if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
          upstreamSocket.destroy();
          return;
        }

        const atyp = buffer[3];
        let expectedLen = 10;
        if (atyp === 0x01) {
          expectedLen = 10; // IPv4
        } else if (atyp === 0x03) {
          if (buffer.length < 5) return;
          expectedLen = 7 + buffer[4]; // Domain: 4 + 1(len) + len + 2
        } else if (atyp === 0x04) {
          expectedLen = 22; // IPv6
        }

        if (buffer.length < expectedLen) return;

        // Tunnel is established!
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstreamSocket.removeAllListeners('data');

        const remainder = buffer.subarray(expectedLen);
        if (remainder.length > 0) {
          clientSocket.write(remainder);
        }

        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }

        // Reset to 60s idle timeout for active tunnel
        upstreamSocket.setTimeout(60_000);

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);

        clientSocket.once('close', () => {
          upstreamSocket.destroy();
        });
        upstreamSocket.once('close', () => {
          clientSocket.destroy();
        });
      }
    });

    upstreamSocket.on('error', (err) => {
      this.logger.debug({ err: err.message, targetHost, targetPort }, 'proxy-forwarder: upstream SOCKS5 error');
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      }
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
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
      const upstreamSocket = net.connect(this.config.port, this.config.host, () => {
        upstreamSocket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      });

      upstreamSocket.setTimeout(15_000);
      upstreamSocket.on('timeout', () => upstreamSocket.destroy(new Error('SOCKS5 timeout')));

      let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
      let buffer = Buffer.alloc(0);

      const sendHttpConnect = () => {
        const isIp = net.isIP(hostHeader);
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(80, 0);
        if (isIp === 4) {
          const parts = hostHeader.split('.').map(Number);
          upstreamSocket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts]), portBuf]));
        } else {
          const domBuf = Buffer.from(hostHeader);
          upstreamSocket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domBuf.length]), domBuf, portBuf]));
        }
      };

      upstreamSocket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const method = buffer[1];
          buffer = buffer.subarray(2);
          if (method === 0x02) {
            stage = 'auth';
            const u = Buffer.from(this.config.username || '');
            const p = Buffer.from(this.config.password || '');
            upstreamSocket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          } else if (method === 0x00) {
            stage = 'connect';
            sendHttpConnect();
          } else {
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            clientRes.end('SOCKS5 auth rejected');
            upstreamSocket.destroy();
          }
        } else if (stage === 'auth') {
          if (buffer.length < 2) return;
          if (buffer[1] !== 0x00) {
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            clientRes.end('SOCKS5 auth failed');
            upstreamSocket.destroy();
            return;
          }
          buffer = buffer.subarray(2);
          stage = 'connect';
          sendHttpConnect();
        } else if (stage === 'connect') {
          if (buffer.length < 4) return;
          if (buffer[1] !== 0x00) {
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            clientRes.end('SOCKS5 connect failed');
            upstreamSocket.destroy();
            return;
          }

          const atyp = buffer[3];
          let expectedLen = 10;
          if (atyp === 0x01) expectedLen = 10;
          else if (atyp === 0x03) {
            if (buffer.length < 5) return;
            expectedLen = 7 + buffer[4];
          } else if (atyp === 0x04) expectedLen = 22;

          if (buffer.length < expectedLen) return;

          upstreamSocket.removeAllListeners('data');

          let pathOnly = rawUrl;
          try {
            if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
              const u = new URL(rawUrl);
              pathOnly = (u.pathname || '/') + (u.search || '');
            }
          } catch {
            pathOnly = rawUrl;
          }

          // Send plain HTTP request line & headers over the established SOCKS5 tunnel
          let reqLine = `${clientReq.method} ${pathOnly} HTTP/1.1\r\n`;
          let headers = '';
          for (const [k, v] of Object.entries(clientReq.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              v.forEach((val) => { headers += `${k}: ${val}\r\n`; });
            } else {
              headers += `${k}: ${v}\r\n`;
            }
          }
          upstreamSocket.write(reqLine + headers + '\r\n');
          clientReq.pipe(upstreamSocket);

          upstreamSocket.on('data', (d) => {
            if (!clientRes.headersSent) {
              (clientRes.socket as net.Socket)?.write(d);
            } else {
              clientRes.write(d);
            }
          });
          upstreamSocket.on('end', () => clientRes.end());
        }
      });

      upstreamSocket.on('error', (err) => {
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
    clientReq.on('close', () => {
      upstreamReq.destroy();
    });
  }
}
