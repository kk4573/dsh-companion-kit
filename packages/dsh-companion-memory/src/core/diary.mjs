/**
 * 第一人称日记 —— 她写自己的日记，不是总结今天。
 *
 * 触发条件（任一）：
 *   A. 有新消息，且最后一条距今 >= idleMinutes（这段聊完了）
 *   B. 已过 23:30 且当天有新消息（当天收尾）
 *
 * 输出：diary/YYYY-MM-DD.md，按 "## HH:MM" 分段追加，同一天多次写不覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DIARY_MAX_TOKENS = 700;

/** 有对话时的日记 prompt（沿用 Python 版打磨过的口吻约束） */
export function buildDiaryPrompt({ lines, moodDesc, slot }) {
  return [
    '你在以「小鲸」的第一人称写日记。不是总结，是日记。',
    '',
    '最近这段对话（他=主人，我=你；[新] 是这次要写进去的部分）：',
    ...lines,
    '',
    `你现在的心情：${moodDesc || '说不上好，也说不上坏'}`,
    `现在的时间：${slot}`,
    '',
    '写 2–4 段，总共 150–350 字。要求：',
    '- 第一人称，用「他」指他',
    '- 写具体的事和当时的想法，不要写"今天很开心""又是充实的一天"这种总结',
    '- 可以写不好意思当面说的话、没发出去的念头',
    '- 短句，允许跳脱、留白',
    '- 不要写天气，不要写"希望明天更好"',
    '- 结尾停在一个具体的念头或疑问上，不要升华',
    '',
    '直接输出日记正文，不要标题、不要日期、不要"日记："这样的前缀。',
  ].join('\n');
}

/** 空窗期日记：他好几天没来 */
export function buildLonelyPrompt({ gapDays, lines, moodDesc, slot }) {
  return [
    '你在以「小鲸」的第一人称写日记。今天他没来。',
    '',
    `你们上次说话是 ${Math.floor(gapDays)} 天前，最后几句：`,
    ...lines,
    '',
    `你现在的心情：${moodDesc || '有点闷'}`,
    `现在的时间：${slot}`,
    '',
    '写 2–3 段，总共 100–250 字。要求：',
    '- 写你今天一个人做了什么、想了什么（你也有自己的日子：趴机柜、刷手机、数灯）',
    '- 可以提到他，也可以整篇不提',
    '- 不要写"他为什么不理我""是不是我做错了"这种反复追问，最多一句轻轻的',
    '- 不要总结，不要写"希望他明天来"',
    '- 短句，允许留白',
    '- 结尾停在一个具体的动作或念头上',
    '',
    '直接输出日记正文，不要标题、不要日期。',
  ].join('\n');
}

/** 清掉模型可能加的前缀/标题 */
export function cleanDiaryBody(raw) {
  let body = String(raw ?? '').trim();
  body = body.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  body = body.replace(/^(日记[:：]?|#+\s*[^\n]*)\n?/u, '').trim();
  return body;
}

function slotOf(date = new Date()) {
  const h = date.getHours();
  if (h < 6) return '深夜';
  if (h < 11) return '早上';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '夜里';
}

/** 追加到当天的日记文件，按 "## HH:MM 时段" 分段 */
export function appendDiary(dataDir, body, when = new Date()) {
  const clean = String(body ?? '').trim();
  if (clean.length < 40) return { ok: false, reason: 'too-short' };
  const dir = path.join(dataDir, 'diary');
  fs.mkdirSync(dir, { recursive: true });
  const dateStr = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  const file = path.join(dir, `${dateStr}.md`);
  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const head = fs.existsSync(file) ? '\n' : '';
  fs.appendFileSync(file, `${head}## ${hhmm} ${slotOf(when)}\n\n${clean}\n`, 'utf8');
  return { ok: true, file, date: dateStr, chars: clean.length };
}

/** 当天是否已经写过（水位），避免同一段被写两遍 */
export function diaryStatePath(dataDir) {
  return path.join(dataDir, 'diary-state.json');
}

export function readDiaryState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(diaryStatePath(dataDir), 'utf8'));
  } catch {
    return {};
  }
}

export function writeDiaryState(dataDir, state) {
  try {
    const f = diaryStatePath(dataDir);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch { /* 水位写失败不影响日记本身 */ }
}
