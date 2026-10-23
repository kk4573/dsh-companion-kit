/**
 * 陪伴体表情库 —— 内置图库，按情绪挑图，通过本地 URL 给 QQ 用。
 *
 * 为什么走 URL：桥的 `qq_send_sticker` 接受 stickerId（emoji_id / md5 / 图片 URL）。
 * 内置图是本地文件，所以插件开一个静态服务把图暴露成 URL，她拿到 URL 就能发。
 *
 * 图库结构（由 tools/classify_stickers.py 生成）：
 *   stickers/
 *   ├── emotions.json         { emotions: {happy: 40, ...}, buckets: {happy: [{name, file, url_path}]} }
 *   └── builtin/<包名>/<表情名>.png
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-companion-sticker';
export const inject = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function log(...a) {
  console.log('[companion-sticker]', ...a);
}
function warn(...a) {
  console.warn('[companion-sticker]', ...a);
}

function resolveConfig(raw) {
  const c = raw ?? {};
  const lab = path.resolve(HERE, '..', '..', '..', '..');
  const dir = String(c.libraryDir ?? '').trim();
  return {
    enabled: c.enabled !== false,
    libraryDir: dir ? path.resolve(dir) : path.join(lab, 'stickers'),
    routeBase: String(c.routeBase || '/companion-sticker').replace(/\/+$/, ''),
    staticPort: Number(c.staticPort) > 0 ? Number(c.staticPort) : 3091,
    maxPick: Number(c.maxPick) > 0 ? Number(c.maxPick) : 8,
    dshBaseUrl: String(c.dshBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, ''),
  };
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    log('已禁用');
    return;
  }

  const indexPath = path.join(config.libraryDir, 'emotions.json');
  const builtinDir = path.join(config.libraryDir, 'builtin');

  /** 缓存索引（改完文件重启生效；图库不常变） */
  let library = { emotions: {}, buckets: {} };
  let loadedAt = 0;

  function loadLibrary(force = false) {
    if (!force && loadedAt && Date.now() - loadedAt < 600000) return library;
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      library = {
        emotions: parsed?.emotions ?? {},
        buckets: parsed?.buckets ?? {},
      };
      loadedAt = Date.now();
      const total = Object.values(library.emotions).reduce((a, b) => a + Number(b || 0), 0);
      log(`图库已加载：${Object.keys(library.emotions).length} 类 / ${total} 张`);
    } catch (err) {
      warn(`读图库失败（${indexPath}）：${err?.message ?? err}`);
      library = { emotions: {}, buckets: {} };
    }
    return library;
  }

  loadLibrary(true);

  /** 从某个情绪桶里随机挑 n 张，返回带完整 URL 的列表 */
  function pick(emotion, n, seed) {
    const lib = loadLibrary();
    const buckets = lib.buckets || {};
    let pool = [];
    const want = String(emotion || '').trim().toLowerCase();

    if (want && buckets[want]) {
      pool = buckets[want];
    } else if (want && want !== 'random' && want !== '任意') {
      // 允许模糊：happy / 开心 / 高兴 都能命中 happy
      const alias = {
        开心: 'happy', 高兴: 'happy', 笑: 'happy',
        无语: 'awkward', 尴尬: 'awkward', 汗: 'awkward',
        生气: 'angry', 怒: 'angry',
        难过: 'sad', 委屈: 'sad', 哭: 'sad',
        害羞: 'shy', 脸红: 'shy',
        困: 'tired', 累: 'tired',
        惊讶: 'surprise', 震惊: 'surprise',
        敷衍: 'ok', 好的: 'ok',
        喜欢: 'love', 爱: 'love', 亲: 'love',
        随便: 'misc', 其他: 'misc',
      };
      const key = alias[want] || want;
      pool = buckets[key] || [];
      if (!pool.length) {
        // 真找不到就退回全库随机
        pool = Object.values(buckets).flat();
      }
    } else {
      pool = Object.values(buckets).flat();
    }

    if (!pool.length) return [];
    // 简单打乱（Fisher-Yates 前 n 个）
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const limit = Math.max(1, Math.min(config.maxPick, Number(n) || 3));
    return arr.slice(0, limit).map((e) => ({
      name: String(e.name || ''),
      package: String(e.package || ''),
      url: `http://127.0.0.1:${config.staticPort}${config.routeBase}/${String(e.url_path || '').replace(/^\/companion-sticker\//, '')}`,
    }));
  }

  // ── 静态服务：把图库暴露成 URL ──────────────────────────
  // 自己起一个 http server，不依赖 DSH 的路由（prefix 匹配行为不稳定）。
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const prefix = `${config.routeBase}/`;
      if (!url.pathname.startsWith(prefix)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const rel = decodeURIComponent(url.pathname.slice(prefix.length));
      const abs = path.resolve(builtinDir, rel);
      if (!abs.startsWith(path.resolve(builtinDir) + path.sep)) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error('not a file');
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(abs).pipe(res);
    } catch (err) {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  try {
    server.listen(config.staticPort, '127.0.0.1', () => {
      log(`静态服务：http://127.0.0.1:${config.staticPort}${config.routeBase}/ → ${builtinDir}`);
    });
    server.on('error', (err) => warn(`静态服务启动失败：${err?.message ?? err}`));
  } catch (err) {
    warn(`静态服务异常：${err?.message ?? err}`);
  }

  // ── 工具 ──────────────────────────────────────────────
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'sticker_stats',
      description: '看看自己的表情库里有哪些情绪分类、各有多少张。发之前想知道有什么可选时用。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'number' },
            emotions: {
              type: 'object',
              additionalProperties: { type: 'number' },
            },
          },
        },
      },
      execute: async () => {
        const lib = loadLibrary();
        const total = Object.values(lib.emotions).reduce((a, b) => a + Number(b || 0), 0);
        return { total, emotions: lib.emotions };
      },
    }), 'companion-sticker: stats');

    scope.effect(() => scope.tools.register({
      name: 'sticker_pick',
      description:
        '从表情库里挑几张表情，返回图片地址。拿到 url 后调 qq_send_sticker（stickerId 填这个 url）发出去。'
        + '情绪可选 happy/awkward/angry/sad/shy/tired/surprise/ok/love/misc，也可以写中文（开心/无语/委屈…），'
        + '留空或写 random 就是全库随机。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          emotion: { type: 'string', description: '情绪；留空 = 随机' },
          count: { type: 'number', description: '要几张候选，默认 3' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            emotion: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  package: { type: 'string' },
                  url: { type: 'string' },
                },
              },
            },
          },
        },
      },
      execute: async ({ emotion, count }) => ({
        emotion: String(emotion || 'random'),
        items: pick(emotion, count),
      }),
    }), 'companion-sticker: pick');
  });

  ctx.effect(() => () => {
    try { server.close(); } catch { /* 已关 */ }
    library = { emotions: {}, buckets: {} };
  }, 'companion-sticker: cleanup');
}
