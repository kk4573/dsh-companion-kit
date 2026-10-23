/**
 * 陪伴体人设插件 —— 把角色卡注入系统提示词。
 *
 * 相比「每条消息前拼一段」，注入 systemPrompt 的好处：
 *   · 人设永远在最前面（order 0），不会被长对话挤出窗口
 *   · 跟 QQ 无关，纯 DSH 会话也能有人设
 *   · 改文件下一轮就生效，不用重启
 *
 * 多套人设共存在 personaDir 里，用 persona_switch 切，状态落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-companion-persona';
/** 需要 systemPrompt 注入段；agents 用来遍历会话 */
export const inject = ['systemPrompt', 'agents'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECTION = 'companion:persona';
const STATE_DIR = path.join(os.homedir(), '.dsh', 'companion-persona');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function log(...a) {
  console.log('[companion-persona]', ...a);
}
function warn(...a) {
  console.warn('[companion-persona]', ...a);
}

function resolveConfig(raw) {
  const c = raw ?? {};
  const lab = path.resolve(HERE, '..', '..', '..', '..');
  const dir = String(c.personaDir ?? '').trim();
  return {
    enabled: c.enabled !== false,
    personaDir: dir ? path.resolve(dir) : path.join(lab, 'persona', 'roles'),
    current: String(c.current ?? '').trim(),
    order: Number.isFinite(Number(c.order)) ? Number(c.order) : 0,
    maxBytes: Number(c.maxBytes) > 0 ? Number(c.maxBytes) : 40000,
  };
}

function readState() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { current: typeof d.current === 'string' ? d.current : '' };
  } catch {
    return { current: '' };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    warn('状态写盘失败：', err?.message ?? err);
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    log('已禁用');
    return;
  }

  if (!fs.existsSync(config.personaDir)) {
    try {
      fs.mkdirSync(config.personaDir, { recursive: true });
    } catch { /* 建不了就算了 */ }
  }
  log(`人设目录：${config.personaDir}`);

  /** 当前选中的名字（优先级：状态文件 > 配置 > 目录第一个） */
  let current = readState().current || config.current;
  /** 文件缓存：{ name, mtime, text } */
  let cache = { name: '', mtime: 0, text: '' };

  function listPersonas() {
    try {
      return fs.readdirSync(config.personaDir)
        .filter((n) => n.toLowerCase().endsWith('.md'))
        .map((n) => n.replace(/\.md$/i, ''))
        .sort();
    } catch {
      return [];
    }
  }

  function pickDefault() {
    const all = listPersonas();
    return all.length ? all[0] : '';
  }

  /** 读人设正文，带 mtime 热重载 */
  function readPersona(name) {
    const target = name || pickDefault();
    if (!target) return { name: '', text: '', missing: true };
    const file = path.join(config.personaDir, `${target}.md`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { name: target, text: '', missing: true };
    }
    if (cache.name === target && cache.mtime === stat.mtimeMs) return cache;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      warn(`读人设失败：${err?.message ?? err}`);
      return { name: target, text: '', missing: true };
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxBytes) {
      warn(`人设「${target}」超过 ${config.maxBytes} 字节，已截断`);
      text = text.slice(0, Math.floor(config.maxBytes / 3));
    }
    // 去掉开头的 Markdown 标题行（`# 小鲸` 这种），和正文连起来更自然
    text = text.replace(/^#\s+[^\n]*\n+/, '').trim();
    cache = { name: target, mtime: stat.mtimeMs, text };
    return cache;
  }

  function renderFor() {
    const { name: n, text, missing } = readPersona(current);
    if (missing || !text) return '';
    return text;
  }

  // ── 注入 ──────────────────────────────────────────────
  const fibers = new Map();

  function installPrompt(agent) {
    if (!agent || fibers.has(agent)) return fibers.get(agent);
    let fiber;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION,
          order: config.order,
          text: () => renderFor(),
          // 人设里可能有 {{ }}、${} 这类字面量，绝不当模板解析
          interpolate: false,
        });
      });
    } catch (err) {
      warn('注册人设段失败：', err?.message ?? err);
      return undefined;
    }
    fibers.set(agent, fiber);
    log(`已为会话 ${String(agent.id)} 注册人设段`);
    ctx.effect(() => () => {
      const f = fibers.get(agent);
      if (!f) return;
      fibers.delete(agent);
      void f.dispose?.();
    }, `companion-persona: dispose ${String(agent.id)}`);
    return fiber;
  }

  for (const agent of ctx.agents.list()) installPrompt(agent);
  ctx.on('agent/created', ({ agent }) => installPrompt(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    const f = fibers.get(agent);
    if (f) {
      fibers.delete(agent);
      void f.dispose?.();
    }
  });

  // ── 工具 ──────────────────────────────────────────────
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'persona_list',
      description: '列出所有可用人设（各自的名字与第一段内容），当前那套会标出来。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            current: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' }, preview: { type: 'string' } },
              },
            },
          },
        },
      },
      execute: async () => {
        const all = listPersonas();
        const items = all.map((n) => {
          const { text } = readPersona(n);
          return { name: n, preview: String(text).replace(/\s+/g, ' ').slice(0, 60) };
        });
        return { current: current || pickDefault(), items };
      },
    }), 'companion-persona: persona_list');

    scope.effect(() => scope.tools.register({
      name: 'persona_switch',
      description: '换一套人设。换完下一轮就生效，不用重启。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', description: '人设名字（不含 .md）' } },
        required: ['name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, current: { type: 'string' }, message: { type: 'string' } },
        },
      },
      execute: async ({ name: want }) => {
        const target = String(want ?? '').trim();
        const all = listPersonas();
        if (!all.includes(target)) {
          return { ok: false, current: current || pickDefault(), message: `没有「${target}」，可选：${all.join('、') || '（空）'}` };
        }
        current = target;
        writeState({ current });
        cache = { name: '', mtime: 0, text: '' };
        log(`已切换人设：${target}`);
        return { ok: true, current: target, message: `已切换到「${target}」，下一轮生效` };
      },
    }), 'companion-persona: persona_switch');
  });

  // 启动时把默认值落盘，避免每次都要重新推导
  if (!current) {
    current = pickDefault();
    if (current) writeState({ current });
  }
  if (!current) warn('人设目录里没有 .md 文件，注入段为空');
  else log(`当前人设：${current}（${Buffer.byteLength(renderFor(), 'utf8')} 字节）`);

  // 状态口：验证注入是否真的拿到了内容
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const d = scope.webServer.register({
        kind: 'exact',
        path: '/companion-persona/state',
        handler: async (req, res) => {
          const { name: n, text, missing } = readPersona(current);
          const body = {
            ok: true,
            current: n,
            missing: Boolean(missing),
            bytes: Buffer.byteLength(text || '', 'utf8'),
            sections: fibers.size,
            available: listPersonas(),
            preview: String(text || '').replace(/\s+/g, ' ').slice(0, 120),
          };
          try {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(body));
          } catch { /* 连接已断 */ }
        },
      });
      log('状态口：/companion-persona/state');
      return () => { try { void d?.(); } catch { /* 忽略 */ } };
    }, 'companion-persona: state route');
  });

  ctx.effect(() => () => {
    fibers.clear();
  }, 'companion-persona: cleanup');
}
