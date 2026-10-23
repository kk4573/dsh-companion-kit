/**
 * 陪伴体记忆插件 —— 让她记得他这个人。
 *
 * 三个来源，每轮注入约 800 token：
 *   【你记得关于他的事】  core.json 的事实（全量，最多 20 条）
 *   【最近两天的日记】     diary/YYYY-MM-DD.md
 *   【说到这个，你想起来】  facts.jsonl 里跟当前这句相关 top-3
 *
 * 设计取舍：
 *   · **数据格式与现有目录完全兼容**（memory/<personaId>/），装上去直接读已有记忆。
 *   · 召回不用向量库：几千条记忆用倒排索引是毫秒级，省掉几百 MB 模型。
 *   · 召回带随机性：每次都精准翻出最相关那条是数据库，不是人。
 *   · 「刚提过的惩罚」：同一件事连着被翻出来像复读机。
 */
import {
  appendFact,
  bumpFacts,
  readCoreFacts,
  readFacts,
  readRecentDiary,
  resolveDataDir,
} from '../core/store.mjs';
import { recall } from '../core/recall.mjs';
import { runForget } from '../core/forget.mjs';
import { EXTRACT_MAX_TOKENS, buildPrompt, parseVerdict } from '../core/extract.mjs';
import {
  DIARY_MAX_TOKENS,
  appendDiary,
  buildDiaryPrompt,
  buildLonelyPrompt,
  cleanDiaryBody,
  readDiaryState,
  writeDiaryState,
} from '../core/diary.mjs';
import {
  MOOD_MAX_TOKENS,
  MOOD_PROMPT,
  buildDialog,
  gapDelta,
  parseMoodVerdict,
  readMood,
  writeMood,
} from '../core/mood.mjs';

const SECTION_NAME = 'companion:memory';
/** 人物设定在前（0），记忆在后（100） */
const SECTION_ORDER = 100;
const CACHE_MS = 30000;

/** cordis 插件身份与依赖声明 —— 不写 inject 就无法访问 ctx.agents / systemPrompt */
export const name = 'dsh-companion-memory';
export const inject = ['systemPrompt', 'agents', 'llm'];

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[companion-memory]', ...args);
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[companion-memory]', ...args);
}

function resolveConfig(raw) {
  const c = raw ?? {};
  return {
    dataDir: String(c.dataDir ?? '').trim(),
    enabled: c.enabled !== false,
    budgetTokens: Number(c.budgetTokens) > 0 ? Number(c.budgetTokens) : 1200,
    diaryDays: Number(c.diaryDays) > 0 ? Number(c.diaryDays) : 2,
    recallTopK: Number(c.recallTopK) > 0 ? Number(c.recallTopK) : 3,
    recallJitter: Number.isFinite(Number(c.recallJitter)) ? Number(c.recallJitter) : 0.12,
    recentlyMentionedPenalty: Number.isFinite(Number(c.recentlyMentionedPenalty))
      ? Number(c.recentlyMentionedPenalty) : 0.5,
    defaultSalience: Number(c.defaultSalience) > 0 ? Number(c.defaultSalience) : 0.5,
    // 心情/好感度：留空 = 不启用（桥那边会用自己的默认值）
    moodFile: String(c.moodFile ?? '').trim(),
    moodIntervalMs: Number(c.moodIntervalMs) > 0 ? Number(c.moodIntervalMs) : 600000,
  };
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const dataDir = resolveDataDir(config.dataDir);
  log(`记忆目录：${dataDir}`);

  /** sessionId -> 会话级状态 */
  const states = new Map();
  /** 对话段缓冲：给日记用。key 固定为 'default'（桥只上报一个主人的私聊） */
  const segmentBuffer = new Map();
  /** 读盘缓存（core / 日记 / facts 各一份） */
  let cache = { at: 0, core: [], diary: [], facts: [] };

  function stateOf(id) {
    let s = states.get(id);
    if (!s) {
      s = { lastUserText: '', recentlyUsed: new Set(), suppressed: false };
      states.set(id, s);
    }
    return s;
  }

  function refreshCache() {
    const now = Date.now();
    if (now - cache.at < CACHE_MS) return cache;
    try {
      cache = {
        at: now,
        core: readCoreFacts(dataDir),
        diary: readRecentDiary(dataDir, config.diaryDays),
        facts: readFacts(dataDir),
      };
    } catch (err) {
      warn('读记忆失败：', err?.message ?? err);
    }
    return cache;
  }

  /** 组装注入文本。每次 system prompt assemble 时求值。 */
  function renderFor(sessionId) {
    if (!config.enabled) return '';
    const s = stateOf(sessionId);
    if (s.suppressed) return '';
    const { core, diary, facts } = refreshCache();
    const parts = [];

    if (core.length) {
      parts.push('【你记得关于他的事】');
      for (const f of core) parts.push(`- ${String(f).slice(0, 120)}`);
    }

    if (diary.length) {
      if (parts.length) parts.push('');
      parts.push('【最近的日记】');
      for (const d of diary) {
        parts.push(`## ${d.date}`);
        parts.push(d.body.slice(0, 1200));
      }
    }

    if (facts.length && s.lastUserText) {
      const picked = recall({
        entries: facts,
        query: s.lastUserText,
        k: config.recallTopK,
        jitter: config.recallJitter,
        recentPenalty: config.recentlyMentionedPenalty,
        recentlyUsed: s.recentlyUsed,
      });
      if (picked.length) {
        if (parts.length) parts.push('');
        parts.push('【说到这个，你想起来】');
        for (const f of picked) {
          parts.push(`- ${String(f.text).slice(0, 100)}`);
          s.recentlyUsed.add(String(f.text));
        }
        // 命中计数异步回写（不阻塞本轮）
        const texts = picked.map((f) => f.text);
        setTimeout(() => {
          try {
            bumpFacts(dataDir, texts);
            cache.at = 0;
          } catch { /* 写不进去也不影响回复 */ }
        }, 0);
      }
    }

    return parts.join('\n');
  }

  // ── 注入：按会话注册 prompt 段 ──────────────────────────────
  const fibers = new Map();

  function installPrompt(agent) {
    if (!agent || fibers.has(agent)) return fibers.get(agent);
    let fiber;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: () => renderFor(String(agent.id)),
          // 记忆里可能出现 {{ }}，绝不能当模板解析
          interpolate: false,
        });
      });
    } catch (err) {
      warn('注册记忆段失败：', err?.message ?? err);
      return undefined;
    }
    fibers.set(agent, fiber);
    log(`已为会话 ${String(agent.id)} 注册记忆段`);
    ctx.effect(() => () => {
      const f = fibers.get(agent);
      if (!f) return;
      fibers.delete(agent);
      void f.dispose?.();
    }, `companion-memory: dispose prompt ${String(agent.id)}`);
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
    states.delete(String(agent?.id));
  });

  // ── 记住他说的话（召回的 query），并支持「别记」 ────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (!config.enabled) return;
      const id = String(session?.id ?? '');
      if (!id) return;
      if (event?.type !== 'user/message') return;
      // 只要真人打的字，过滤掉系统注入的消息
      if (event.data?.source?.kind !== 'user') return;
      const text = (event.data.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) return;
      const s = stateOf(id);
      s.lastUserText = text;
      s.recentlyUsed = new Set();
      s.suppressed = /别记|不要记|别存|不用记|忘掉这个|删除记忆/.test(text);
    } catch (err) {
      warn('处理会话事件失败：', err?.message ?? err);
    }
  });

  // ── 工具：让她能主动记一笔、也能主动翻旧账 ──────────────────
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'memory_note',
      description:
        '给自己留一条长期记忆。想到什么值得让以后的自己记得的，直接写进来。'
        + '只记关于他的事（身份、喜好、发生过的事、约定），不要记一次性的技术细节和寒暄。'
        + '一句话，第一人称，像跟以后的自己说话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '一句话，不超过 60 字' },
          kind: {
            type: 'string',
            enum: ['permanent', 'important', 'normal'],
            description: 'permanent=身份家人长期偏好（永不遗忘）；important=近期的事和约定（一个月）；normal=一般信息（一周）',
          },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
      },
      execute: async ({ text, kind }) => {
        try {
          const k = kind || 'normal';
          const salience = k === 'permanent' ? 0.9 : k === 'important' ? 0.7 : config.defaultSalience;
          const rec = appendFact(dataDir, text, k, salience);
          cache.at = 0;
          return { ok: true, text: `记住了：${rec.text}` };
        } catch (err) {
          return { ok: false, text: `没记住：${err?.message ?? err}` };
        }
      },
    }), 'companion-memory: memory_note');

    scope.effect(() => scope.tools.register({
      name: 'memory_recall',
      description: '翻旧账：按关键词找他以前说过的事。想不起某个细节时用它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要找什么，几个关键词就行' },
          limit: { type: 'number', description: '要几条，默认 5' },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { text: { type: 'string' }, kind: { type: 'string' } },
              },
            },
          },
        },
      },
      execute: async ({ query, limit }) => {
        const { facts } = refreshCache();
        const picked = recall({
          entries: facts,
          query: String(query ?? ''),
          k: Math.max(1, Math.min(20, Number(limit) || 5)),
          jitter: 0,
        });
        return { items: picked.map((f) => ({ text: String(f.text), kind: String(f.kind || 'normal') })) };
      },
    }), 'companion-memory: memory_recall');
  });

  // ── HTTP 上报口：给不走 agent 生命周期的通道用（比如 QQ 桥的 /v1/chat/completions）──
  // 桥走的不是 agent 回合，`turn-stopping` 永远不会触发；由桥把用户那句话 POST 过来。
  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 20000) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  function sendJson(res, code, payload) {
    try {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(payload));
    } catch { /* 连接已断 */ }
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const routes = [
        {
          kind: 'exact',
          path: '/companion-memory/say',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
            const body = await readBody(req);
            const text = String(body?.text ?? '').trim();
            if (!text) return sendJson(res, 400, { ok: false, error: 'empty' });
            if (!config.enabled) return sendJson(res, 200, { ok: true, kept: false, reason: 'disabled' });
            try {
              // 先进对话缓冲（不管值不值得记，日记和心情要的是整段对话）
              const buf = segmentBuffer.get('default') ?? { messages: [], lastAt: 0 };
              buf.messages.push({ text, at: Date.now() });
              buf.lastAt = Date.now();
              if (buf.messages.length > 80) buf.messages.shift();
              segmentBuffer.set('default', buf);

              const v = await judgeAndExtract(text);
              if (!v) return sendJson(res, 200, { ok: true, kept: false, reason: 'no-model' });
              if (!v.keep || !v.text) return sendJson(res, 200, { ok: true, kept: false });
              const salience = v.kind === 'permanent' ? 0.9 : v.kind === 'important' ? 0.7 : config.defaultSalience;
              appendFact(dataDir, v.text, v.kind, salience);
              cache.at = 0;
              log(`记住（上报）：${v.text}`);
              return sendJson(res, 200, { ok: true, kept: true, text: v.text, kind: v.kind });
            } catch (err) {
              warn('上报处理失败：', err?.message ?? err);
              return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        },
        {
          kind: 'exact',
          path: '/companion-memory/diary',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
            await maybeWriteDiary(true);
            const { diary } = refreshCache();
            return sendJson(res, 200, { ok: true, days: diary.map((d) => d.date) });
          },
        },
        {
          kind: 'exact',
          path: '/companion-memory/mood',
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
            await scoreMood();
            const file = config.moodFile;
            return sendJson(res, 200, { ok: true, mood: file ? readMood(file) : null });
          },
        },
        {
          kind: 'exact',
          path: '/companion-memory/state',
          handler: async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method' });
            const { core, diary, facts } = refreshCache();
            return sendJson(res, 200, {
              ok: true, dataDir, coreCount: core.length,
              diaryDays: diary.map((d) => d.date), factsCount: facts.length,
            });
          },
        },
      ];
      const disposers = routes.map((r) => scope.webServer.register(r));
      log('上报口已注册：/companion-memory/{say,state}');
      return () => {
        for (const d of disposers) {
          try { void d?.(); } catch { /* 忽略 */ }
        }
      };
    }, 'companion-memory: http routes');
  });

  // ── 每轮结束：判断这一句值不值得记 ────────────────────────
  let jobQueue = Promise.resolve();

  function currentModel() {
    try {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (sel?.provider && sel?.model) {
        return { provider: sel.provider, model: config.model || sel.model };
      }
    } catch { /* 拿不到就跳过本轮判断，不猜 */ }
    return undefined;
  }

  async function judgeAndExtract(said) {
    const sel = currentModel();
    if (!sel) {
      warn('取不到默认模型，本轮跳过');
      return null;
    }
    const { facts } = refreshCache();
    const built = buildPrompt({ said, recentFacts: facts });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    let raw = '';
    try {
      for await (const chunk of ctx.llm.stream({
        provider: sel.provider,
        model: sel.model,
        system: built.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: built.user }] }],
        maxTokens: EXTRACT_MAX_TOKENS,
        temperature: 0,
        // 后台任务绝不继承前台的思考档位（踩过：token 全烧在推理上，正文一个字没产出）
        reasoningEffort: 'off',
        signal: abort.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text;
      }
    } finally {
      clearTimeout(timer);
    }
    return parseVerdict(raw);
  }

  function enqueueExtract(said) {
    if (!config.enabled || !said || said.length < 2) return;
    jobQueue = jobQueue.then(async () => {
      try {
        const v = await judgeAndExtract(said);
        if (!v) return;
        if (!v.keep) {
          log(`跳过：${said.slice(0, 24)}`);
          return;
        }
        if (!v.text) return;
        const salience = v.kind === 'permanent' ? 0.9 : v.kind === 'important' ? 0.7 : config.defaultSalience;
        appendFact(dataDir, v.text, v.kind, salience);
        cache.at = 0;
        log(`记住：${v.text}`);
      } catch (err) {
        warn('抽取失败：', err?.message ?? err);
      }
    });
  }

  // turn-stopping 是 serial 事件、会被 await —— 这里只入队，绝不在这个栈里发请求
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const id = String(agent?.id ?? '');
      const s = stateOf(id);
      const said = s.lastUserText;
      if (!said) {
        log(`回合结束（无用户文本，跳过判断）`);
        return;
      }
      log(`回合结束，判断：${said.slice(0, 30)}`);
      s.lastUserText = '';
      enqueueExtract(said);
    } catch (err) {
      warn('回合结束处理失败：', err?.message ?? err);
    }
  });

  // ── 分级遗忘：每 6 小时检查一次（幂等，没到期的不会动）────────
  const forgetTimer = setInterval(() => {
    try {
      const r = runForget(dataDir);
      if (r.moved) {
        cache.at = 0;
        log(`遗忘：${r.moved} 条转冷，剩 ${r.remaining} 条`);
      }
    } catch (err) {
      warn('遗忘失败：', err?.message ?? err);
    }
  }, 6 * 3600 * 1000);
  forgetTimer.unref?.();

  ctx.effect(() => () => {
    clearInterval(forgetTimer);
  }, 'companion-memory: forget timer');

  // ── 写日记：聊完一段（空闲 30 分钟）或当天 23:30 收尾 ─────────
  let diaryBusy = false;

  async function maybeWriteDiary(force = false) {
    if (diaryBusy || !config.enabled) return;
    const buf = segmentBuffer.get('default');
    if (!buf || buf.messages.length < 3) return;

    const now = new Date();
    const idleMs = Date.now() - (buf.lastAt || 0);
    const h = now.getHours();
    const pastEod = h > 23 || (h === 23 && now.getMinutes() >= 30);
    if (!force && !(idleMs >= 30 * 60 * 1000 || pastEod)) return;

    const sel = currentModel();
    if (!sel) return;

    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const st = readDiaryState(dataDir);
    // 同一段（同一天 + 同条数）不重复写
    if (st.lastDate === dateKey && Number(st.lastCount) === buf.messages.length) return;

    diaryBusy = true;
    const count = buf.messages.length;
    try {
      const prompt = buildDiaryPrompt({
        lines: buf.messages.slice(-40).map((m) => `他：${String(m?.text ?? m).slice(0, 200)}`),
        moodDesc: '',
        slot: '',
      });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 90000);
      let raw = '';
      try {
        for await (const chunk of ctx.llm.stream({
          provider: sel.provider,
          model: sel.model,
          system: prompt,
          messages: [{ role: 'user', content: [{ type: 'text', text: '写吧。' }] }],
          maxTokens: DIARY_MAX_TOKENS,
          temperature: 0.9,
          reasoningEffort: 'off',
          signal: abort.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text;
        }
      } finally {
        clearTimeout(timer);
      }

      const body = cleanDiaryBody(raw);
      const r = appendDiary(dataDir, body, now);
      if (r.ok) {
        writeDiaryState(dataDir, { lastDate: dateKey, lastCount: count, at: Date.now() });
        buf.messages = [];
        buf.lastAt = 0;
        cache.at = 0;
        log(`日记：${r.chars} 字 → ${r.date}`);
      } else {
        warn(`日记太短（${r.reason}），这次不写`);
      }
    } catch (err) {
      warn('写日记失败：', err?.message ?? err);
    } finally {
      diaryBusy = false;
    }
  }

  const diaryTimer = setInterval(() => {
    void maybeWriteDiary();
  }, 5 * 60 * 1000);
  diaryTimer.unref?.();

  ctx.effect(() => () => {
    clearInterval(diaryTimer);
  }, 'companion-memory: diary timer');

  // ── 心情/好感度：每 10 分钟检查，只评新消息（没新消息不调模型）─────
  let moodBusy = false;

  async function scoreMood() {
    if (moodBusy || !config.enabled || !config.moodFile) return;
    const buf = segmentBuffer.get('default');
    const mood = readMood(config.moodFile);
    const now = Date.now();

    // 空窗推进：他好几天没来，心情按天走，不是冻结
    if (!buf || !buf.messages.length) {
      const gapDays = mood.lastScoredMsgTime ? (now - mood.lastScoredMsgTime) / 86400000 : 0;
      if (gapDays >= 3) {
        const g = gapDelta(gapDays, mood.mood);
        if (g.delta) {
          mood.affection = Math.max(0, Math.min(100, mood.affection + g.delta));
          mood.mood = g.mood;
          mood.note = g.note;
          mood.lastScoredAt = now;
          writeMood(config.moodFile, mood);
          log(`空窗 ${Math.floor(gapDays)} 天：好感 ${mood.affection} | ${mood.mood}`);
        }
      }
      return;
    }

    const fresh = buf.messages.filter((m) => Number(m?.at) > mood.lastScoredMsgTime);
    if (!fresh.length) return;

    moodBusy = true;
    try {
      const sel = currentModel();
      if (!sel) return;
      const texts = buf.messages.map((m) => String(m?.text ?? m));
      const dialog = buildDialog(texts, texts.length - fresh.length);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 45000);
      let raw = '';
      try {
        for await (const chunk of ctx.llm.stream({
          provider: sel.provider,
          model: sel.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: MOOD_PROMPT.replace('{dialog}', dialog) }] }],
          maxTokens: MOOD_MAX_TOKENS,
          temperature: 0,
          reasoningEffort: 'off',
          signal: abort.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text;
        }
      } finally {
        clearTimeout(timer);
      }

      const v = parseMoodVerdict(raw);
      if (!v) {
        warn('心情打分解析失败：', raw.slice(0, 80));
        return;
      }
      mood.affection = Math.max(0, Math.min(100, mood.affection + v.delta));
      mood.mood = v.mood;
      mood.note = v.note;
      mood.lastScoredAt = Date.now();
      mood.lastScoredMsgTime = Number(fresh[fresh.length - 1]?.at) || Date.now();
      writeMood(config.moodFile, mood);
      log(`好感 ${mood.affection} (${v.delta >= 0 ? '+' : ''}${v.delta}) | 心情: ${mood.mood} | ${v.note}`);
    } catch (err) {
      warn('心情打分失败：', err?.message ?? err);
    } finally {
      moodBusy = false;
    }
  }

  const moodTimer = setInterval(() => {
    void scoreMood();
  }, config.moodIntervalMs);
  moodTimer.unref?.();

  ctx.effect(() => () => {
    clearInterval(moodTimer);
  }, 'companion-memory: mood timer');

  ctx.effect(() => () => {
    states.clear();
    fibers.clear();
  }, 'companion-memory: cleanup');
}
