# dsh-companion-persona

给陪伴体一套可热切换的人设：把角色卡注入系统提示词，改文件下一轮生效，不用重启。

## 安装

```bash
dsh plugin --profile web add dsh-companion-persona
```

```yaml
- id: companion-persona
  name: 'dsh-companion-persona'
  config:
    personaDir: 'D:/lab/persona/roles'   # 放多个 .md，每个一套人设
    current: '小鲸'                       # 当前用哪套（文件名去掉 .md）
```

> 路径要显式给。插件装在 `node_modules` 里，用 `import.meta.url` 往上推只会得到 profile 目录。

## 人设文件

普通 markdown，一个文件一套：

```markdown
# 小鲸

## 一、你是谁
你叫小鲸。……

## 二、怎么说话
- 短句。
- 不用"呢呀啦嘛"。

## 三、不做什么
- 不追问"怎么了"。
- 不总结他的情绪。
```

开头的 `# 标题` 会被去掉（标题不参与注入），其余原样注入 `systemPrompt`，`order: 0`——排在记忆段之前。

**改完保存，下一轮就生效**（按文件 mtime 热重载，不用重启 DSH）。

## 工具

| 工具 | 用途 |
|---|---|
| `persona_list` | 列出所有可用人设（名字 + 前 60 字预览），标出当前的 |
| `persona_switch` | 切到指定人设，下一轮生效 |

当前选择落盘在 `~/.dsh/companion-persona/state.json`，重启后保持。

## 状态口

```
GET /companion-persona/state
```

```json
{
  "ok": true,
  "current": "小鲸",
  "missing": false,
  "bytes": 9814,
  "sections": 1,
  "available": ["小鲸", "测试-冷淡"],
  "preview": "……"
}
```

`sections` 是已注册人设段的会话数。**刚启动时是 0，等第一个会话创建后才会变成 1**（agent 是按需创建的，不是启动时全量加载）。

## 注入顺序

```
order 0    人设（本插件）
order 100  记忆（dsh-companion-memory）
```

人设永远在最前面，不会被长对话挤出窗口。

## 已知限制

- 单个人设超过 `maxBytes`（默认 40 KB）会被截断并在日志里警告。
- 人设是全局的：所有会话共用同一套。多伙伴要各用各的，得给每个伙伴单独的 profile。
- 和桥的「角色卡」功能重叠：桥那边还有 `roles/*.md` + `/api/roles/*`。装了本插件后，人设由插件负责注入，桥的角色提示只用于显示当前角色名。

## 许可

MIT
