/**
 * 记忆抽取 —— 判断这一句值不值得记，值得就提炼成一行。
 *
 * 判据（借自 feiyu-memory）：
 *   1. 任务会催你，日子不会催你。
 *   2. 他讲得越随便，越可能压了很久。
 *   3. 判据是「他说完这句，我对他的了解有没有变一点」。
 *
 * 为什么不记寒暄：今天吃了什么、嗯、好、在吗 —— 记下来只会把真正的事挤掉。
 *
 * ⚠️ **错误代价不对称**：漏记一条永久没了，而且你连"少了什么"都不知道；
 * 多记一条只是占几行，能删能降级。所以**认不出格式就默认记**，宁可多记。
 */

export const EXTRACT_MAX_TOKENS = 90;

export const SYSTEM_PROMPT = [
  '你在决定「这句话值不值得长期记住」。只做这一件事，不要回应用户。',
  '',
  '值得记的：他的身份、家人朋友、工作学习、喜好与厌恶、身体和作息、',
  '经历过的事、答应过的事、他反复提的东西、他说话的方式。',
  '不值得记的：寒暄（嗯、好、在吗、早）、一次性的技术指令、',
  '已经记过的同一件事、纯粹的客套。',
  '',
  '三条判据：',
  '1. 任务会催你，日子不会催你。没有催你的那句话，反而更值得停一下。',
  '2. 他讲得越随便，越可能压了很久。',
  '3. 判据是「他说完这句，我对他的了解有没有变一点」。',
  '',
  '输出格式（只能二选一，不要解释）：',
  '  记：<一句话，不超过 40 字，第三人称，以"他"开头>',
  '  跳过',
].join('\n');

/** 判断 + 提炼，一次调用完成。返回 {keep, text, kind} */
export function buildPrompt({ said, recentFacts = [] }) {
  const seen = recentFacts.length
    ? `\n\n已经记过的（别重复记）：\n${recentFacts.slice(0, 8).map((f) => `- ${String(f.text).slice(0, 50)}`).join('\n')}`
    : '';
  return {
    system: SYSTEM_PROMPT,
    user: `他说：${String(said).slice(0, 800)}${seen}`,
  };
}

/** 解析模型输出。**认不出就默认记**（漏记的代价不可见，多记只占几行）。 */
export function parseVerdict(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { keep: true, text: '', kind: 'normal', fallback: true };

  // 明确说跳过
  if (/^跳过|^skip/i.test(text)) return { keep: false, text: '', kind: 'normal' };

  const m = text.match(/记[：:]\s*(.+)/);
  if (m && m[1].trim()) {
    const body = m[1].trim().replace(/^["'「]|["'」]$/g, '').slice(0, 80);
    return { keep: true, text: body, kind: guessKind(body) };
  }

  // 模型没按格式来，但说了人话 —— 当成内容记下，比丢掉好
  const first = text.split('\n')[0].trim();
  if (first.length >= 4) {
    return { keep: true, text: first.slice(0, 80), kind: guessKind(first), fallback: true };
  }
  return { keep: false, text: '', kind: 'normal' };
}

/** 粗判等级：约定/近期 → important；身份/家人/长期偏好 → permanent */
export function guessKind(text) {
  const s = String(text);
  // 约定优先判断：「他答应明天叫我起床」是 important，不该被「叫」误判成身份
  if (/答应|约好|约了|明天|后天|下周|周末|周[一二三四五六日]|考试|面试|截止|提醒|deadline|几点/.test(s)) {
    return 'important';
  }
  if (/他叫|我叫|名字|姓名|生日|家人|父母|爸爸|妈妈|专业|学校|学院|学号|班级|年级|大[一二三四]|住在|工作|女朋友|男朋友|习惯|喜欢|讨厌/.test(s)) {
    return 'permanent';
  }
  return 'normal';
}
