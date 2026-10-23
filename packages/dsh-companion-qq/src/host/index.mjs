/**
 * 陪伴体 QQ 接入插件 —— 管进程，不管消息。
 *
 * 职责：
 *   1. 启动时确认 SnowLuma 和桥在跑，没跑就拉起来
 *   2. 定时健康检查（端口探测），挂了就重启
 *   3. 连续失败时退避，避免无限重试刷日志、弹窗口
 *
 * 消息流不经过这里：桥是独立进程，直接用 DSH 的 /v1/chat/completions。
 * 这个插件只保证「那两个东西活着」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-companion-qq';
/** 不依赖 agent / systemPrompt：本插件只管进程 */
export const inject = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, '..', '..', 'logs');

function log(...a) {
  console.log('[companion-qq]', ...a);
}
function warn(...a) {
  console.warn('[companion-qq]', ...a);
}

function resolveConfig(raw) {
  const c = raw ?? {};
  // 默认路径：插件在 <lab>/packages/dsh-companion-qq/src/host/ → 往上四层是 <lab>
  const lab = path.resolve(HERE, '..', '..', '..', '..');
  const pick = (v, def) => (String(v ?? '').trim() ? path.resolve(String(v).trim()) : def);
  return {
    enabled: c.enabled !== false,
    snowlumaDir: pick(c.snowlumaDir, path.join(lab, 'vendor', 'SnowLuma')),
    bridgeDir: pick(c.bridgeDir, path.join(lab, 'upstream', 'qq-bridge')),
    bridgePort: Number(c.bridgePort) > 0 ? Number(c.bridgePort) : 3100,
    snowlumaPorts: [5099, 3000, 3001],
    healthIntervalMs: Number(c.healthIntervalMs) > 0 ? Number(c.healthIntervalMs) : 300000,
    maxFailures: Number(c.maxConsecutiveFailures) > 0 ? Number(c.maxConsecutiveFailures) : 3,
    backoffMinutes: Array.isArray(c.backoffMinutes) && c.backoffMinutes.length
      ? c.backoffMinutes.map(Number).filter((n) => n > 0)
      : [5, 15, 30],
    dshBaseUrl: String(c.dshBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, ''),
  };
}

/** 端口是否在监听（连得上就算） */
function portOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 已断 */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** HTTP 判活：端口在听不代表服务活着（真踩过） */
async function httpAlive(url, timeoutMs = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return r.ok || r.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    log('已禁用（config.enabled = false）');
    return;
  }

  log(`SnowLuma: ${config.snowlumaDir}`);
  log(`桥:       ${config.bridgeDir}（端口 ${config.bridgePort}）`);

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* 建不了也不影响 */ }

  /** 本插件拉起的子进程 */
  const owned = new Set();
  let failures = 0;
  let busy = false;
  let stopped = false;

  function openLogFile(tag) {
    const file = path.join(LOG_DIR, `${tag}-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      return fs.openSync(file, 'a');
    } catch {
      return 'ignore';
    }
  }

  /** Windows 上不弹黑框 */
  const HIDE = process.platform === 'win32'
    ? { windowsHide: true, detached: false }
    : {};

  function spawnChild(tag, command, args, cwd) {
    const out = openLogFile(tag);
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', out, out],
      ...HIDE,
    });
    child.on('error', (err) => warn(`${tag} 启动失败：${err.message}`));
    child.on('exit', (code, signal) => {
      owned.delete(child);
      if (!stopped) log(`${tag} 退出（code=${code} signal=${signal}）`);
    });
    owned.add(child);
    log(`${tag} 已启动 pid=${child.pid}`);
    return child;
  }

  async function ensureSnowLuma() {
    const ports = config.snowlumaPorts;
    const states = await Promise.all(ports.map((p) => portOpen(p)));
    if (states.every(Boolean)) return true;
    // 面板在但 OneBot 不在，说明启动时 QQ 没登录 —— 也要重来
    const launcher = path.join(config.snowlumaDir, 'launcher.bat');
    if (!fs.existsSync(launcher)) {
      warn(`找不到 launcher.bat：${launcher}`);
      return false;
    }
    log('SnowLuma 未就绪，启动中（需要 QQ 已登录）');
    spawnChild('snowluma', 'cmd', ['/c', launcher], config.snowlumaDir);
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = await Promise.all(ports.map((p) => portOpen(p)));
      if (now.every(Boolean)) {
        log('SnowLuma 三个端口就绪');
        return true;
      }
    }
    warn('SnowLuma 60 秒内没起来（多半是 QQ 未登录）');
    return false;
  }

  async function ensureBridge() {
    if (await portOpen(config.bridgePort)) {
      if (await httpAlive(`${config.dshBaseUrl}/v1/models`)) return true;
      // 桥在、DSH 不通 —— 桥会自己重连，这里不重启
      log('桥在跑，DSH 暂不可达（桥会重连）');
      return true;
    }
    const entry = path.join(config.bridgeDir, 'src', 'bridge.js');
    if (!fs.existsSync(entry)) {
      warn(`找不到桥入口：${entry}`);
      return false;
    }
    log('桥未就绪，启动中');
    const node = process.execPath;
    spawnChild('bridge', node, [entry], config.bridgeDir);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      if (await portOpen(config.bridgePort)) {
        log('桥端口就绪');
        return true;
      }
    }
    warn('桥 30 秒内没起来');
    return false;
  }

  async function healthCheck() {
    if (busy || stopped) return;
    busy = true;
    try {
      const snowOk = await ensureSnowLuma();
      const bridgeOk = await ensureBridge();
      if (snowOk && bridgeOk) {
        if (failures > 0) log(`恢复正常（此前连续失败 ${failures} 次）`);
        failures = 0;
        return;
      }
      failures += 1;
      if (failures >= config.maxFailures) {
        const idx = Math.min(failures - config.maxFailures, config.backoffMinutes.length - 1);
        const waitMin = config.backoffMinutes[idx];
        warn(`连续失败 ${failures} 次，退避 ${waitMin} 分钟后再试`);
        // 暂时停手：把定时器换成一次性延迟
        if (timer) clearInterval(timer);
        timer = setTimeout(() => {
          failures = 0;
          timer = setInterval(() => { void healthCheck(); }, config.healthIntervalMs);
          void healthCheck();
        }, waitMin * 60 * 1000);
        timer.unref?.();
      }
    } catch (err) {
      warn('健康检查异常：', err?.message ?? err);
    } finally {
      busy = false;
    }
  }

  // 首次检查延后 15 秒，等 DSH 自己先起来
  const kickoff = setTimeout(() => { void healthCheck(); }, 15000);
  kickoff.unref?.();
  let timer = setInterval(() => { void healthCheck(); }, config.healthIntervalMs);
  timer.unref?.();

  // 状态端点
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const d = scope.webServer.register({
        kind: 'exact',
        path: '/companion-qq/status',
        handler: async (req, res) => {
          const body = {
            ok: true,
            failures,
            owned: [...owned].map((c) => c.pid),
            snowluma: await Promise.all(config.snowlumaPorts.map((p) => portOpen(p))),
            bridge: await portOpen(config.bridgePort),
            dsh: await httpAlive(`${config.dshBaseUrl}/v1/models`),
          };
          try {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
          } catch { /* 连接已断 */ }
        },
      });
      log('状态口：/companion-qq/status');
      return () => { try { void d?.(); } catch { /* 忽略 */ } };
    }, 'companion-qq: status route');
  });

  ctx.effect(() => () => {
    stopped = true;
    clearTimeout(kickoff);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    // 只杀自己拉起来的，不碰用户手动启动的
    for (const child of owned) {
      try { child.kill(); } catch { /* 已经没了 */ }
    }
    owned.clear();
    log('已停止（自己拉起的子进程已关闭）');
  }, 'companion-qq: cleanup');
}
