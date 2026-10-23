/**
 * 陪伴体能力说明插件 —— 把「工具怎么用」固定注入系统提示词。
 *
 * 为什么单独拆出来：
 *   以前这些写在人设卡里，换一套人设就一起丢了 —— 阿苔不知道有 359 张表情，
 *   也不知道自己会发语音。能力应该跟着「这个 agent」走，不跟着「这个性格」走。
 *
 * 注入顺序：
 *   order 0    人设（companion-persona）
 *   order 50   能力说明（本插件）
 *   order 100  记忆（companion-memory）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-companion-skills';
export const inject = ['systemPrompt', 'agents'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECTION = 'companion:skills';

function log(...a) {
  console.log('[companion-skills]', ...a);
}
function warn(...a) {
  console.warn('[companion-skills]', ...a);
}

function resolveConfig(raw) {
  const c = raw ?? {};
  const lab = path.resolve(HERE, '..', '..', '..', '..');
  const file = String(c.skillsFile ?? '').trim();
  return {
    enabled: c.enabled !== false,
    skillsFile: file ? path.resolve(file) : path.join(lab, 'persona', 'skills.md'),
    order: Number.isFinite(Number(c.order)) ? Number(c.order) : 50,
    maxBytes: Number(c.maxBytes) > 0 ? Number(c.maxBytes) : 40000,
  };
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    log('已禁用');
    return;
  }

  log(`能力说明：${config.skillsFile}`);

  /** 文件缓存（按 mtime 热重载） */
  let cache = { mtime: 0, text: '' };

  function readSkills() {
    let stat;
    try {
      stat = fs.statSync(config.skillsFile);
    } catch {
      warn(`读不到能力说明：${config.skillsFile}`);
      return '';
    }
    if (cache.mtime === stat.mtimeMs) return cache.text;
    let text = '';
    try {
      text = fs.readFileSync(config.skillsFile, 'utf8');
    } catch (err) {
      warn(`读失败：${err?.message ?? err}`);
      return '';
    }
    if (Buffer.byteLength(text, 'utf8') > config.maxBytes) {
      warn(`能力说明超过 ${config.maxBytes} 字节，已截断`);
      text = text.slice(0, Math.floor(config.maxBytes / 3));
    }
    cache = { mtime: stat.mtimeMs, text: text.trim() };
    return cache.text;
  }

  // 启动时读一次，日志里能看出有没有内容
  const first = readSkills();
  log(first ? `已加载（${Buffer.byteLength(first, 'utf8')} 字节）` : '内容为空');

  const fibers = new Map();

  function installPrompt(agent) {
    if (!agent || fibers.has(agent)) return fibers.get(agent);
    let fiber;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION,
          order: config.order,
          text: () => readSkills(),
          // 里面全是 `代码` 和 {}，绝不当模板解析
          interpolate: false,
        });
      });
    } catch (err) {
      warn('注册能力段失败：', err?.message ?? err);
      return undefined;
    }
    fibers.set(agent, fiber);
    log(`已为会话 ${String(agent.id)} 注册能力段`);
    ctx.effect(() => () => {
      const f = fibers.get(agent);
      if (!f) return;
      fibers.delete(agent);
      void f.dispose?.();
    }, `companion-skills: dispose ${String(agent.id)}`);
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

  // 状态口：确认注入的是哪份文件、多大
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const d = scope.webServer.register({
        kind: 'exact',
        path: '/companion-skills/state',
        handler: async (req, res) => {
          const text = readSkills();
          const body = {
            ok: true,
            file: config.skillsFile,
            bytes: Buffer.byteLength(text, 'utf8'),
            sections: fibers.size,
            preview: text.replace(/\s+/g, ' ').slice(0, 100),
          };
          try {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(body));
          } catch { /* 连接已断 */ }
        },
      });
      log('状态口：/companion-skills/state');
      return () => { try { void d?.(); } catch { /* 忽略 */ } };
    }, 'companion-skills: state route');
  });

  ctx.effect(() => () => {
    fibers.clear();
    cache = { mtime: 0, text: '' };
  }, 'companion-skills: cleanup');
}
