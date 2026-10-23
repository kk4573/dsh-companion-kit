# 陪伴体套件（DSH Companion Kit）

给 [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) 装一个**记得你**的陪伴体：它会记住关于你的事，每天自己写日记，聊得久了还会淡忘不重要的部分。

目标不是做一个大而全的黑盒，而是**一组可以单独安装、单独替换的小插件**。这个仓库目前包含第一块：记忆。

---

## 现在有什么

| 插件 | 作用 | 状态 |
|---|---|---|
| `dsh-companion-memory` | 记忆：注入、判断、日记、遗忘 | 可用 |
| `dsh-companion-qq` | QQ 接入：自动启停 SnowLuma 与桥，带健康守护 | 可用 |
| 人设 | 一键换人格 | 计划中 |
| 表情 / 语音 | 发图和说话 | 计划中 |
| 主动性 | 主动找你、空窗期反应 | 计划中 |

---

## 安装记忆插件

前置条件：DSH ≥ `0.2.0-rc.2`。

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-companion-memory

# 或从本地目录
dsh plugin --profile web add file:/path/to/packages/dsh-companion-memory
```

然后在 profile 的 `cordis.patch.yml` 里指定记忆目录：

```yaml
- id: companion-memory
  name: 'dsh-companion-memory'
  config:
    dataDir: 'D:/my-companion/memory'
```

> **注意**：`dsh plugin` 会调用 pnpm，而 pnpm **不读** profile 的 `.npmrc`。如果你的网络访问 `registry.npmjs.org` 困难，先在 profile 目录里写一行：
>
> ```
> registry=https://registry.npmmirror.com
> ```

重启 DSH，日志里应该出现：

```
[companion-memory] 记忆目录：D:/my-companion/memory
[companion-memory] 已为会话 session-xxx 注册记忆段
```

---

## 它做什么

### 1. 注入

每轮对话，往系统提示词里放三段内容，总共约 800 token：

```
【你记得关于他的事】      core.json 里的事实（全量，最多 20 条）
【最近的日记】           diary/ 最近两天的日记
【说到这个，你想起来】    facts.jsonl 里跟当前这句相关的 top-3
```

### 2. 判断

每句话都问一次模型：**这句值不值得长期记住？**

判据只有三条：

1. **任务会催你，日子不会催你。** 没有催你的那句话，反而更值得停一下。
2. **他讲得越随便，越可能压了很久。**
3. **判据是「他说完这句，我对他的了解有没有变一点」。**

输出只有两种：`记：<一句话>` 或 `跳过`。

**认不出格式就默认记。** 因为漏记一条永久没了，而且你连“少了什么”都不知道；多记一条只是占几行，能删能降级。

### 3. 遗忘

| 等级 | 基础寿命 | 说明 |
|---|---|---|
| `permanent` | 永不 | 身份、家人、长期偏好 |
| `important` | 30 天 | 近期的事、约定 |
| `normal` | 7 天 | 一般信息 |

被想起过的记忆活得更久：

```
有效寿命 = 基础天数 × (1 + min(hits, 5) × 0.2)
```

一条 `normal` 最多撑到 14 天，`important` 最多 60 天。

**到期不是删除，是转冷**：条目从 `facts.jsonl` 移到 `archive/YYYY-MM.jsonl`，标记 `state: cold`。冷记忆不注入提示词，但还在磁盘上。

### 4. 日记

聊完一段（空闲 30 分钟）或当天 23:30 之后，用第一人称写一篇日记，追加到 `diary/YYYY-MM-DD.md`。

不是总结今天，是日记：具体的事、没发出去的念头、停在动作上、不升华。

---

## 数据在哪

```
dataDir/
├── core.json              关于他的事实（最多 20 条，全量注入）
├── facts.jsonl            事实库，一行一条
├── diary/
│   └── YYYY-MM-DD.md      第一人称日记，按 ## HH:MM 分段
├── archive/
│   └── YYYY-MM.jsonl      冷记忆（转冷不删除）
└── diary-state.json       日记水位（防止同一段写两遍）
```

全部是纯文本，可以直接看、直接改、直接备份。

### 数据格式

`core.json`：

```json
{
  "facts": [
    "他叫 kk，西北工业大学计算机学院，大三",
    "他有熬夜修东西到一点半的习惯"
  ]
}
```

`facts.jsonl`（一行一条）：

```json
{"text":"他做数据库实验到十点，常熬夜赶任务","kind":"important","salience":0.7,"createdAt":1761400000000,"lastSeenAt":1761400000000,"hits":0}
```

| 字段 | 含义 |
|---|---|
| `text` | 一句话，不超过 80 字 |
| `kind` | `permanent` / `important` / `normal` |
| `salience` | 重要度 0~1，影响召回排序 |
| `hits` | 被召回过的次数，影响寿命 |
| `createdAt` / `lastSeenAt` | 毫秒时间戳 |

---

## 工具

插件给 agent 装了两个工具：

| 工具 | 用途 |
|---|---|
| `memory_note` | 主动记一笔（`text` + 可选 `kind`） |
| `memory_recall` | 按关键词翻旧账，返回 top-k |

还有一个 HTTP 口，给不走 agent 会话的通道用（比如桥接层）：

```
POST /companion-memory/say     {"text": "他今天说的那句话"}
GET  /companion-memory/state   看当前数据概况
POST /companion-memory/diary   手动触发写日记
```

---

## 设计取舍

**不用向量库。** 几千条记忆，倒排索引是毫秒级；向量模型要几百 MB，换来的召回提升在这个量级上不明显。

**召回带随机性。** 打分里留 12% 的抖动：

```
打分 = 相似度 × 0.55 + salience × 0.20 + 新鲜度 × 0.15 − 刚提过 × 0.10 + 噪声
```

人本来就是联想到什么说什么。每次都精准翻出最相关那条，是数据库，不是人。

**「刚提过的惩罚」。** 同一件事连着被翻出来，像复读机。

**后台任务不继承思考档位。** 所有后台调用都显式传 `reasoningEffort: 'off'`。踩过的坑：跟随前台档位时，900 个 token 全烧在推理上，正文一个字没产出。

---

## 已知限制

- **一个 profile 同一时间只能跑一个**：DSH 的 web 服务固定端口，多开需要多台机器。
- 日记依赖模型的写作质量，弱模型会写得像总结。
- 判断每轮多一次模型调用（约 90 output token），高频聊天时成本会累积。

---

## 开发

```bash
# 装到本地 profile 调试
dsh plugin --profile web add file:$(pwd)/packages/dsh-companion-memory

# 改完源码后同步（pnpm 装的是副本，不是软链）
cp -r packages/dsh-companion-memory/src/* \
      ~/.dsh/profiles/web/node_modules/dsh-companion-memory/src/
```

注意：cordis 插件**必须**在模块顶层声明依赖，否则访问 `ctx.agents` 会直接抛错：

```js
export const name = 'dsh-companion-memory';
export const inject = ['systemPrompt', 'agents', 'llm'];
```

---

## 许可

MIT
