/**
 * Transparent proxying for rooted boards (Magisk `su`).
 *
 * Non-rooted phones only proxy apps that honour Android's global HTTP proxy. On rooted
 * boards we additionally redirect ALL outgoing TCP with iptables into a local sing-box
 * `redirect` inbound, whose single outbound is the farm gateway on 127.0.0.1:8888
 * (the same `adb reverse` port the system proxy uses). Credentials, SOCKS/HTTP and
 * connection limits are therefore handled in one place — the PC gateway.
 *
 * Proxies only carry TCP, so the leak guard also rejects IPv6 and non-DNS/NTP UDP
 * (QUIC, WebRTC): apps fall back to IPv4/TCP, which goes through the proxy.
 *
 * Fail-safe: iptables rules are installed only after sing-box is confirmed listening,
 * otherwise the board would lose all connectivity.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from 'pino';
import type { AdbClient } from './adb-client';
import { config } from './config';

const REMOTE_DIR = '/data/local/tmp';
const REMOTE_BIN = `${REMOTE_DIR}/sing-box`;
const REMOTE_CFG = `${REMOTE_DIR}/kmm-singbox.json`;
const REMOTE_SCRIPT = `${REMOTE_DIR}/kmm-proxy.sh`;
const REDIRECT_PORT = 12345;
const SING_BOX_VERSION = '1.14.2';

function controlScript(): string {
  const portHex = REDIRECT_PORT.toString(16).toUpperCase().padStart(4, '0');
  return `#!/system/bin/sh
# Managed by kmmzavod device-agent: transparent TCP proxy via sing-box + iptables.
BIN=${REMOTE_BIN}
CFG=${REMOTE_CFG}
LOG=${REMOTE_DIR}/kmm-singbox.log
PORT=${REDIRECT_PORT}

stop_rules() {
  iptables -t nat -D OUTPUT -p tcp -j KMM_PROXY 2>/dev/null
  iptables -t nat -F KMM_PROXY 2>/dev/null
  iptables -t nat -X KMM_PROXY 2>/dev/null
  iptables -D OUTPUT -p udp -j KMM_UDP 2>/dev/null
  iptables -F KMM_UDP 2>/dev/null
  iptables -X KMM_UDP 2>/dev/null
  ip6tables -D OUTPUT -j KMM_V6 2>/dev/null
  ip6tables -F KMM_V6 2>/dev/null
  ip6tables -X KMM_V6 2>/dev/null
  # chain left by older agent versions
  iptables -t nat -D OUTPUT -p tcp -j SINGBOX 2>/dev/null
  iptables -t nat -F SINGBOX 2>/dev/null
  iptables -t nat -X SINGBOX 2>/dev/null
}

stop_daemon() {
  for pid in $(pidof sing-box); do kill -9 "$pid" 2>/dev/null; done
}

listening() {
  grep -q "0100007F:${portHex} 00000000:0000 0A" /proc/net/tcp 2>/dev/null
}

start_rules() {
  iptables -t nat -N KMM_PROXY || return 1
  for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    iptables -t nat -A KMM_PROXY -d "$net" -j RETURN || return 1
  done
  iptables -t nat -A KMM_PROXY -p tcp -j REDIRECT --to-ports "$PORT" || return 1
  iptables -t nat -A OUTPUT -p tcp -j KMM_PROXY || return 1

  if iptables -N KMM_UDP 2>/dev/null; then
    for net in 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
      iptables -A KMM_UDP -d "$net" -j RETURN
    done
    iptables -A KMM_UDP -p udp --dport 53 -j RETURN
    iptables -A KMM_UDP -p udp --dport 123 -j RETURN
    iptables -A KMM_UDP -p udp -j REJECT
    iptables -I OUTPUT 1 -p udp -j KMM_UDP
  fi

  if ip6tables -N KMM_V6 2>/dev/null; then
    for net in ::1/128 fe80::/10 fc00::/7 ff00::/8; do
      ip6tables -A KMM_V6 -d "$net" -j RETURN
    done
    ip6tables -A KMM_V6 -p udp --dport 53 -j RETURN
    ip6tables -A KMM_V6 -p tcp -j REJECT --reject-with tcp-reset
    ip6tables -A KMM_V6 -j REJECT
    ip6tables -I OUTPUT 1 -j KMM_V6
  fi
  return 0
}

case "$1" in
  start)
    stop_rules
    stop_daemon
    chmod 755 "$BIN"
    nohup "$BIN" run -c "$CFG" > "$LOG" 2>&1 &
    i=0
    while ! listening; do
      i=$((i+1))
      if [ "$i" -gt 40 ] || ! pidof sing-box >/dev/null; then
        echo "KMM_FAIL: sing-box did not start"
        tail -n 15 "$LOG" 2>/dev/null
        stop_daemon
        exit 1
      fi
      sleep 0.2
    done
    if ! start_rules; then
      echo "KMM_FAIL: iptables rules were rejected"
      stop_rules
      stop_daemon
      exit 1
    fi
    echo KMM_OK
    ;;
  stop)
    stop_rules
    stop_daemon
    echo KMM_STOPPED
    ;;
  status)
    if pidof sing-box >/dev/null && listening && iptables -t nat -C OUTPUT -p tcp -j KMM_PROXY 2>/dev/null; then
      echo KMM_RUNNING
    else
      echo KMM_DOWN
    fi
    ;;
  *)
    echo "usage: $0 start|stop|status"
    exit 2
    ;;
esac
`;
}

function singBoxConfig(gatewayPort: number): string {
  return JSON.stringify(
    {
      log: { level: 'warn', timestamp: true },
      inbounds: [{ type: 'redirect', tag: 'redirect-in', listen: '127.0.0.1', listen_port: REDIRECT_PORT }],
      outbounds: [{ type: 'http', tag: 'farm-gateway', server: '127.0.0.1', server_port: gatewayPort }],
      route: { final: 'farm-gateway' },
    },
    null,
    2,
  );
}

export class RootTransparentProxy {
  private rootCache = new Map<string, { rooted: boolean; at: number }>();
  private localBinary: Promise<string> | null = null;

  constructor(
    private readonly adb: AdbClient,
    private readonly logger: Logger,
  ) {}

  /** Last known root status without touching the device (undefined = never checked). */
  knownRooted(deviceId: string): boolean | undefined {
    return this.rootCache.get(deviceId)?.rooted;
  }

  /**
   * `su -c id` — cached, because each call may pop a Magisk grant toast/prompt on the board.
   */
  async isRooted(deviceId: string): Promise<boolean> {
    const cached = this.rootCache.get(deviceId);
    const ttl = cached?.rooted ? 30 * 60_000 : 5 * 60_000;
    if (cached && Date.now() - cached.at < ttl) return cached.rooted;
    let rooted = false;
    try {
      const out = await this.adb.shell(deviceId, 'su -c id 2>/dev/null', 15_000);
      rooted = out.includes('uid=0(');
    } catch {
      rooted = false;
    }
    this.rootCache.set(deviceId, { rooted, at: Date.now() });
    return rooted;
  }

  async start(deviceId: string, gatewayPort: number): Promise<void> {
    const abi = (await this.adb.shell(deviceId, 'getprop ro.product.cpu.abi', 10_000)).trim();
    if (!abi.startsWith('arm64')) {
      throw new Error(`архитектура ${abi || 'unknown'} не поддерживается встроенным sing-box (нужна arm64-v8a)`);
    }
    await this.ensureRemoteBinary(deviceId);
    await this.pushText(deviceId, singBoxConfig(gatewayPort), REMOTE_CFG);
    await this.pushText(deviceId, controlScript(), REMOTE_SCRIPT);
    const out = await this.adb.shell(deviceId, `su -c 'sh ${REMOTE_SCRIPT} start' 2>&1`, 40_000);
    if (!out.includes('KMM_OK')) {
      throw new Error(`sing-box не запустился: ${out.trim().slice(-400) || 'нет вывода'}`);
    }
    this.logger.info({ deviceId, gatewayPort }, 'root-proxy: transparent redirect active');
  }

  async stop(deviceId: string): Promise<void> {
    await this.pushText(deviceId, controlScript(), REMOTE_SCRIPT).catch(() => {});
    await this.adb.shell(deviceId, `su -c 'sh ${REMOTE_SCRIPT} stop' 2>&1`, 20_000).catch(() => {});
  }

  private async pushText(deviceId: string, content: string, remotePath: string): Promise<void> {
    const tmp = path.join(os.tmpdir(), `kmm-${process.pid}-${Date.now()}-${path.basename(remotePath)}`);
    fs.writeFileSync(tmp, content.replace(/\r\n/g, '\n'), 'utf-8');
    try {
      await this.adb.exec(['-s', deviceId, 'push', tmp, remotePath], 30_000);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private async ensureRemoteBinary(deviceId: string): Promise<void> {
    const local = await this.ensureLocalBinary();
    const localSize = fs.statSync(local).size;
    const remoteSize = Number(
      (await this.adb.shell(deviceId, `stat -c %s ${REMOTE_BIN} 2>/dev/null || echo 0`, 10_000)).trim(),
    );
    if (remoteSize === localSize) return;
    this.logger.info({ deviceId, localSize, remoteSize }, 'root-proxy: pushing sing-box binary to board');
    await this.adb.exec(['-s', deviceId, 'push', local, REMOTE_BIN], 180_000);
    await this.adb.shell(deviceId, `chmod 755 ${REMOTE_BIN}`, 10_000);
  }

  /** Bundled `bin/sing-box` (android-arm64); downloaded from GitHub releases when missing. */
  private ensureLocalBinary(): Promise<string> {
    if (!this.localBinary) {
      this.localBinary = this.resolveLocalBinary().catch((err) => {
        this.localBinary = null;
        throw err;
      });
    }
    return this.localBinary;
  }

  private async resolveLocalBinary(): Promise<string> {
    const binDir = path.resolve(config.SCRIPTS_DIR, '..', 'bin');
    const binPath = path.join(binDir, 'sing-box');
    if (fs.existsSync(binPath)) return binPath;

    fs.mkdirSync(binDir, { recursive: true });
    const name = `sing-box-${SING_BOX_VERSION}-android-arm64`;
    const tarPath = path.join(binDir, 'sing-box.tar.gz');
    const url = `https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/${name}.tar.gz`;
    this.logger.info({ url }, 'root-proxy: downloading sing-box for android-arm64');
    try {
      execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-L', '-s', '-f', '-o', tarPath, url], { stdio: 'ignore' });
      execFileSync('tar', ['-xzf', tarPath, '-C', binDir, '--strip-components=1', `${name}/sing-box`], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(`не удалось скачать sing-box (${url}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      fs.rmSync(tarPath, { force: true });
    }
    if (!fs.existsSync(binPath)) throw new Error(`бинарник sing-box не найден: ${binPath}`);
    return binPath;
  }
}
