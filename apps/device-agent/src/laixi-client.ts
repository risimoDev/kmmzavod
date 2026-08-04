/**
 * Client for Laixi Master's local WebSocket API (ws://127.0.0.1:22221/).
 *
 * Protocol per docs.laixi.app: send `{"action": "<Name>", "comm": {...}}`,
 * one message per request. The public docs do NOT confirm a correlation id
 * on responses, so this client assumes one in-flight request at a time per
 * connection (queued) and resolves on the next message received after
 * sending — CALIBRATE THIS against your real Laixi install (log the raw
 * response shape via `agent.raw()` below and adjust `send()` if Laixi
 * actually echoes a request id).
 */
import WebSocket from 'ws';
import { config } from './config';
import type { Logger } from 'pino';

export class LaixiClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly url: string, private readonly logger: Logger) {}

  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const onOpen = () => {
        this.ws = ws;
        this.connecting = null;
        this.logger.info({ url: this.url }, 'laixi: connected');
        resolve();
      };
      const onError = (err: Error) => {
        this.connecting = null;
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.on('close', () => {
        this.logger.warn('laixi: connection closed');
        if (this.ws === ws) this.ws = null;
      });
    });

    return this.connecting;
  }

  /** Fire an action and wait for the next message on the socket. Serialized (one at a time). */
  async send<T = unknown>(action: string, comm: Record<string, unknown> = {}, timeoutMs = config.LAIXI_TIMEOUT_MS): Promise<T> {
    const task = this.queue.then(() => this.sendNow<T>(action, comm, timeoutMs));
    // Swallow rejection in the chain so one failure doesn't wedge the queue forever.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async sendNow<T>(action: string, comm: Record<string, unknown>, timeoutMs: number): Promise<T> {
    await this.connect();
    const ws = this.ws;
    if (!ws) throw new Error('laixi: not connected');

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMessage);
        reject(new Error(`laixi: timeout waiting for response to action=${action} (${timeoutMs}ms)`));
      }, timeoutMs);

      const onMessage = (data: WebSocket.RawData) => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        const text = data.toString();
        this.logger.debug({ action, response: text }, 'laixi: raw response');
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          resolve(text as unknown as T);
        }
      };

      ws.on('message', onMessage);
      const payload = JSON.stringify({ action, comm });
      this.logger.info({ action, comm }, 'laixi: send');
      ws.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          reject(err);
        }
      });
    });
  }

  async listDevices(): Promise<unknown> {
    return this.send('GetAllinfo');
  }

  /** Download a file (by URL) directly onto the device — see Laixi API 5.11. */
  async httpDownload(deviceIds: string, url: string, savePath: string): Promise<unknown> {
    return this.send('httpdown', { deviceIds, url, path: savePath });
  }

  /** Run an Autox.js script on the device(s) — see Laixi API 5.10. filePath is local to the Laixi PC. */
  async executeAutoJs(deviceIds: string, filePath: string): Promise<unknown> {
    return this.send('ExecuteAutoJs', { deviceIds, filePath });
  }

  async stopAutoJs(deviceIds: string, filePath: string): Promise<unknown> {
    return this.send('StopAutoJs', { deviceIds, filePath });
  }

  async screenshot(deviceIds: string): Promise<unknown> {
    return this.send('screenshot', { deviceIds });
  }

  async currentActivity(deviceIds: string): Promise<unknown> {
    return this.send('Current Activity', { deviceIds });
  }
}
