# dsh-companion-memory

给 [DSH](https://github.com/deepseek-ai/DeepSeek-Harness) 的陪伴体记忆插件：记住关于他的事，每天自己写日记，久了会淡忘不重要的部分。

## 安装

```bash
dsh plugin --profile web add dsh-companion-memory
```

在 profile 的 `cordis.patch.yml` 里指定记忆目录：

```yaml
- id: companion-memory
  name: 'dsh-companion-memory'
  config:
    dataDir: 'D:/my-companion/memory'
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `~/.dsh/companion-memory` | 记忆目录 |
| `enabled` | `true` | 总开关 |
| `budgetTokens` | `1200` | 注入预算（参考值，不强制截断） |
| `diaryDays` | `2` | 注入最近几天的日记 |
| `recallTopK` | `3` | 每次召回几条往事 |
| `recallJitter` | `0.12` | 召回随机性（0 = 永远最相关） |
| `recentlyMentionedPenalty` | `0.5` | 刚提过的惩罚强度 |
| `defaultSalience` | `0.5` | 新记忆的默认重要度 |
| `model` | `''` | 留空 = 跟随 DSH 当前默认模型 |

## 它做什么

- **注入**：每轮往系统提示词放「记得的事」「最近的日记」「说到这个你想起来」，约 800 token。
- **判断**：每句都问一次模型值不值得记，认不出格式就默认记。
- **遗忘**：7 / 30 天到期转冷（不删除），被想起过的活得更久。
- **日记**：聊完一段或 23:30 后，第一人称写一篇。

## 数据

纯文本，`core.json` / `facts.jsonl` / `diary/*.md` / `archive/*.jsonl`。可以直接看、直接改、直接备份。

## 工具

- `memory_note` — 主动记一笔
- `memory_recall` — 按关键词翻旧账

## HTTP 口

```
POST /companion-memory/say     {"text": "..."}   给不走 agent 会话的通道用
GET  /companion-memory/state                     数据概况
POST /companion-memory/diary                     手动触发写日记
```

## 许可

MIT
