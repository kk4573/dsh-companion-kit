/**
 * 心情与好感度 —— 每聊一段给她算一次，不聊就按天慢慢变。
 *
 * 输出写在 mood.json（桥会读它，用来调整主动唤醒的频率和语气）：
 *   { affection, mood, note, lastScoredAt, lastScoredMsgTime }
 *
 * 关键设计：**增量打分**。只评上次之后的新消息，没有新消息就直接退出、不调模型。
 * 否则每 10 分钟把整段对话重评一遍，好感度会虚涨。
 */
import fs from 'node:fs';
import path from 'node:path';

export const MOOD_MAX_TOKENS = 300;
export const MOODS = ['高兴', '中性', '闷', '想你', '委屈'];

export const MOOD_PROMPT = `你在给一个 AI 角色算"这段对话让她心情和好感度怎么变"。

对话（他=主人，她=AI 角色；[旧] 只是上下文，[新] 才是要评的部分）：
{dialog}

**只评估标了 [新] 的消息**，[旧] 的不要重复计入。

只输出 JSON，不要解释：
{"affection_delta": 整数, "mood": "高兴|中性|闷|想你|委屈", "note": "不超过20字的原因"}

评分标准：
- 他主动找她、夸她、聊得投入 → delta +2~+5，mood 高兴/想你
- 普通闲聊 → delta 0~+1，mood 中性
- 他敷衍、冷淡、很久才回、说伤人的话 → delta -2~-5，mood 闷/委屈
- 无可评估内容 → delta 0，mood 保持中性`;

/** 空窗推进：他多久没来，心情按天走，不是冻结 */
export function gapDelta(gapDays, currentMood) {
  if (gapDays < 3) return { delta: 0, mood: currentMood, note: '' };
  // 3 天后每天 -2，封顶 -10
  const days = Math.floor(gapDays - 3) + 1;
  const delta = -Math.min(days * 2, 10);
  let mood = currentMood;
  if (gapDays >= 7) mood = '委屈';
  else if (gapDays >= 4) mood = '闷';
  return { delta, mood, note: `他 ${Math.floor(gapDays)} 天没来` };
}

/** 解析模型输出，宽容处理（可能带代码块、前后废话） */
export function parseMoodVerdict(raw) {
  const text = String(raw ?? '');
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    const delta = Math.max(-10, Math.min(10, Math.round(Number(v.affection_delta) || 0)));
    const mood = MOODS.includes(v.mood) ? v.mood : '中性';
    const note = String(v.note ?? '').slice(0, 40);
    return { delta, mood, note };
  } catch {
    return null;
  }
}

/** 读 mood.json（不存在就给默认值） */
export function readMood(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      affection: Number.isFinite(Number(d.affection)) ? Number(d.affection) : 50,
      mood: MOODS.includes(d.mood) ? d.mood : '中性',
      note: String(d.note ?? ''),
      lastScoredAt: Number(d.lastScoredAt) || 0,
      lastScoredMsgTime: Number(d.lastScoredMsgTime) || 0,
    };
  } catch {
    return { affection: 50, mood: '中性', note: '', lastScoredAt: 0, lastScoredMsgTime: 0 };
  }
}

/** 原子写 mood.json */
export function writeMood(file, mood) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mood, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 组对话文本：旧的作上下文，新的标 [新] */
export function buildDialog(messages, newFrom, contextBefore = 6) {
  const list = Array.isArray(messages) ? messages : [];
  const from = Math.max(0, Math.min(newFrom, list.length));
  const start = Math.max(0, from - contextBefore);
  const lines = [];
  for (let i = start; i < list.length; i += 1) {
    const tag = i >= from ? '[新] ' : '[旧] ';
    lines.push(`${tag}他：${String(list[i]).slice(0, 200)}`);
  }
  return lines.join('\n');
}
