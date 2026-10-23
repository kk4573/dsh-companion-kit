/**
 * 分级遗忘 —— 把该淡的记忆移到冷区。
 *
 * 规则：
 *   normal     7 天后转冷
 *   important  30 天后转冷
 *   permanent  永不转冷
 *
 * 但**被想起过的记忆活得更久**：
 *   有效寿命 = 基础天数 × (1 + min(hits,5) × 0.2)
 * 一条 normal 最多撑到 14 天，important 最多 60 天。
 * 这比"到期就删"像人 —— 你反复想起的事，本来就不容易忘。
 *
 * 转冷不是删除：条目从 facts.jsonl 移到 archive/YYYY-MM.jsonl，标 state=cold。
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86400000;
const BASE_DAYS = { normal: 7, important: 30 };

export function planForget(facts, now = Date.now()) {
  const hot = [];
  const cold = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    const kind = String(f?.kind || 'normal').toLowerCase();
    if (kind === 'permanent') {
      hot.push(f);
      continue;
    }
    const base = BASE_DAYS[kind] ?? 7;
    const hits = Math.min(Number(f?.hits || 0), 5);
    const effectiveDays = base * (1 + hits * 0.2);
    const last = Number(f?.lastSeenAt || f?.createdAt || now);
    const ageDays = (now - last) / DAY_MS;
    if (ageDays >= effectiveDays) {
      cold.push({ ...f, state: 'cold', archivedAt: now });
    } else {
      hot.push(f);
    }
  }
  return { hot, cold };
}

/** 执行一次遗忘，返回 {moved, remaining}。写盘失败时不抛，只返回 0。 */
export function runForget(dataDir, now = Date.now()) {
  const factsFile = path.join(dataDir, 'facts.jsonl');
  let text = '';
  try {
    text = fs.readFileSync(factsFile, 'utf8');
  } catch {
    return { moved: 0, remaining: 0 };
  }
  const facts = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec.text === 'string') facts.push(rec);
    } catch {
      // 坏行丢弃（它本来也读不出来）
    }
  }
  if (!facts.length) return { moved: 0, remaining: 0 };

  const { hot, cold } = planForget(facts, now);
  if (!cold.length) return { moved: 0, remaining: hot.length };

  try {
    const tmp = factsFile + '.tmp';
    fs.writeFileSync(tmp, hot.map((f) => JSON.stringify(f)).join('\n') + (hot.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, factsFile);

    const archiveDir = path.join(dataDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const d = new Date(now);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const af = path.join(archiveDir, `${month}.jsonl`);
    fs.appendFileSync(af, cold.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8');
  } catch {
    return { moved: 0, remaining: facts.length };
  }

  return { moved: cold.length, remaining: hot.length };
}
