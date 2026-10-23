/**
 * 记忆存储层 —— 读写 core.json / diary / facts.jsonl。
 *
 * 设计原则：**数据格式完全兼容现有目录**（memory/<personaId>/），
 * 装上去就能读已有的记忆，不需要迁移。写回也保持同样的字段名。
 *
 * 零依赖，只用 node 内置模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DAY_MS = 86400000;

/** 解析记忆目录：配置优先，其次 ~/.dsh/companion-memory */
export function resolveDataDir(configured) {
  const raw = String(configured ?? '').trim();
  if (raw) return path.resolve(raw.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), '.dsh', 'companion-memory');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 关于他的事实（core.json 的 facts 数组，最多 20 条） */
export function readCoreFacts(dataDir) {
  const text = readText(path.join(dataDir, 'core.json'));
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data?.facts) ? data.facts : [];
    return list.filter((x) => typeof x === 'string' && x.trim()).slice(0, 20);
  } catch {
    return [];
  }
}

/** 最近 N 天的日记，返回 [{date, body}]，新的在后 */
export function readRecentDiary(dataDir, days = 2, now = Date.now()) {
  const dir = path.join(dataDir, 'diary');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  } catch {
    return [];
  }
  names.sort();
  const cutoff = now - days * DAY_MS;
  const out = [];
  for (const name of names) {
    const dateStr = name.replace(/\.md$/, '');
    const t = Date.parse(dateStr + 'T00:00:00');
    if (Number.isFinite(t) && t < cutoff - DAY_MS) continue;
    const body = readText(path.join(dir, name)).trim();
    if (body) out.push({ date: dateStr, body });
  }
  return out.slice(-Math.max(1, days));
}

/** 事实库（facts.jsonl，一行一条） */
export function readFacts(dataDir) {
  const text = readText(path.join(dataDir, 'facts.jsonl'));
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec.text === 'string' && rec.text.trim()) out.push(rec);
    } catch {
      // 坏行跳过，不影响其它条目
    }
  }
  return out;
}

/** 追加一条事实（工具用）。返回写入的记录。 */
export function appendFact(dataDir, text, kind = 'normal', salience = 0.5) {
  const clean = String(text ?? '').trim().slice(0, 200);
  if (!clean) throw new Error('记忆内容不能为空');
  const k = ['permanent', 'important', 'normal'].includes(kind) ? kind : 'normal';
  const now = Date.now();
  const rec = {
    text: clean,
    kind: k,
    salience: Math.max(0, Math.min(1, Number(salience) || 0.5)),
    createdAt: now,
    lastSeenAt: now,
    hits: 0,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, 'facts.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/** 回写命中计数（召回时用），原子替换 */
export function bumpFacts(dataDir, texts) {
  const wanted = new Set((texts ?? []).map((t) => String(t)));
  if (!wanted.size) return;
  const list = readFacts(dataDir);
  if (!list.length) return;
  const now = Date.now();
  let changed = false;
  for (const f of list) {
    if (wanted.has(String(f.text))) {
      f.hits = Number(f.hits || 0) + 1;
      f.lastSeenAt = now;
      changed = true;
    }
  }
  if (!changed) return;
  const file = path.join(dataDir, 'facts.jsonl');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, list.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
