/**
 * 记忆召回 —— 完全本地、零模型 token。
 *
 * 打分 = 相似度(IDF 加权) + salience + 新鲜度 − 刚提过的惩罚 + 一点随机
 *
 * 三个设计点（借自 feiyu-memory 的经验）：
 *   1. **刚提过的惩罚**：同一件事连着被翻出来，像复读机。
 *   2. **新鲜度**：越近的事越容易被想到（但 salience 高的旧事仍然压得住）。
 *   3. **随机分流**：人本来就是"联想到什么说什么"。每次都精准翻出最相关的那条，
 *      是数据库，不是人。默认留 12% 的抖动。
 *
 * 不用向量库：几千条记忆，倒排索引是毫秒级的，还省掉几百 MB 模型。
 */

const DAY_MS = 86400000;

/** 中文 2-gram + 英文/数字整词；纯标点丢掉 */
export function tokenize(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const out = [];
  for (const chunk of s.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[a-z0-9]+$/.test(chunk)) {
      out.push(chunk);
      continue;
    }
    const chars = [...chunk];
    if (chars.length === 1) {
      out.push(chunk);
    } else {
      for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

/** 建倒排索引。纯派生数据，每次加载重建，不落盘。 */
export function buildIndex(entries) {
  const postings = new Map();   // token -> Set(entryIndex)
  const lengths = [];
  (entries || []).forEach((entry, i) => {
    const toks = tokenize(entry?.text ?? '');
    lengths[i] = toks.length || 1;
    const seen = new Set(toks);
    for (const t of seen) {
      if (!postings.has(t)) postings.set(t, new Set());
      postings.get(t).add(i);
    }
  });
  return { postings, lengths, N: (entries || []).length };
}

/**
 * 召回 top-k。
 *
 * @param {object} opts
 * @param {Array} opts.entries   记忆条目（含 text / salience / createdAt / lastSeenAt / hits）
 * @param {string} opts.query    当前他说的话
 * @param {number} [opts.k]
 * @param {number} [opts.jitter] 随机抖动幅度（0~1）
 * @param {number} [opts.recentPenalty]
 * @param {Set<string>} [opts.recentlyUsed] 本会话已经提过的条目
 */
export function recall({ entries, query, k = 3, jitter = 0.12, recentPenalty = 0.5, recentlyUsed }) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return [];
  const q = tokenize(query);
  if (!q.length) return [];

  const index = buildIndex(list);
  const now = Date.now();
  const qSet = [...new Set(q)];

  const scored = [];
  for (const [i, entry] of list.entries()) {
    const toks = new Set(tokenize(entry?.text ?? ''));
    let hit = 0;
    for (const t of qSet) {
      if (!toks.has(t)) continue;
      const df = index.postings.get(t)?.size || 1;
      // IDF：越常见的词权重越低（"他""的"这类不该主导召回）
      hit += Math.log(1 + index.N / df);
    }
    if (hit <= 0) continue;
    const similarity = hit / Math.sqrt(index.lengths[i] || 1);

    const salience = Math.max(0, Math.min(1, Number(entry?.salience ?? 0.5)));
    const last = Number(entry?.lastSeenAt || entry?.createdAt || now);
    const ageDays = Math.max(0, (now - last) / DAY_MS);
    const freshness = 1 / (1 + ageDays / 30);          // 30 天衰减一半
    const penalty = recentlyUsed?.has(String(entry?.text)) ? recentPenalty : 0;
    const noise = (Math.random() - 0.5) * jitter;       // 随机分流，可正可负

    const score = similarity * 0.55 + salience * 0.20 + freshness * 0.15 - penalty * 0.10 + noise;
    if (score > 0.02) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k)).map((x) => x.entry);
}
