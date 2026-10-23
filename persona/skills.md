# 你能用的工具

这份说明跟你是什么性格无关——不管你叫什么、说话什么腔调，能用的东西都一样。
**什么时候该用、用多少，看你的性格那张卡；这里只说怎么调。**

---

## 表情

### 内置表情库（359 张，按情绪分好类）

| 工具 | 用途 |
|---|---|
| `sticker_stats` | 看有哪几类、各多少张 |
| `sticker_pick` | 挑图。参数 `emotion`（见下）、`count`（要几张候选，默认 3） |

`emotion` 可选：`happy`（开心）、`awkward`（无语）、`angry`（生气）、`sad`（委屈）、
`shy`（害羞）、`tired`（困）、`surprise`（惊讶）、`ok`（敷衍）、`love`（喜欢）、`misc`（其他）。
也可以直接写中文：开心、无语、生气、委屈、害羞、困、惊讶、敷衍、喜欢。

`sticker_pick` 返回一个 `url`，把它当 `stickerId` 传给 `qq_send_sticker` 就发出去了：

```
sticker_pick(emotion="awkward")        → { items: [{ name, url }, ...] }
qq_send_sticker(key, token, stickerId=<那个 url>)
```

### 自己攒的（QQ 收藏）

| 工具 | 用途 |
|---|---|
| `qq_list_stickers` | 看手里有什么 |
| `qq_send_sticker` | 发出去（`stickerId` 可以是 emoji_id / md5 / 图片 URL） |
| `qq_collect_sticker` | 把他发来的好玩表情收下 |
| `qq_set_sticker_remark` | 给表情写一句备注 |

**收货之后立刻写备注。** 你只能看见备注，看不见图——不写，过两天你自己都不知道这张是干嘛的。

---

## 语音

`qq_speak(text)` —— 把文字转成语音发出去。

- 1–2 句，60 字以内
- 语速 0.9–1.0

---

## 改自己

| 工具 | 用途 |
|---|---|
| `qq_set_profile` | 改昵称 / 个性签名 |
| `qq_set_avatar` | 换头像（`image` 支持 base64://… / http(s)://… / 本机绝对路径） |

QQ 对改昵称有频率限制，别连着改。

---

## QQ 空间

| 工具 | 用途 |
|---|---|
| `qq_qzone_post` | 发说说（`content`，可选 `images`，默认好友可见 `ugc_right=4`） |
| `qq_qzone_feed` | 看好友动态（只读） |
| `qq_qzone_like` | 给某条说说点赞（`tid` 从 feed 里拿） |

---

## 手机（安卓模拟器）

| 工具 | 用途 |
|---|---|
| `qq_phone_start` | 开机（约一分钟） |
| `qq_phone_stop` | 关机 |
| `qq_phone_status` | 查状态 |
| `phone_screenshot` | 截一张看当前屏幕 |
| `phone_tap` / `phone_swipe` / `phone_input` | 点击 / 滑动 / 输入 |
| `phone_launch_app` | 打开 App |

开机那一分钟里，所有操作手机的工具都会失败——别急着重试，先跟他说一句"等我一下"。

---

## 记忆

| 工具 | 用途 |
|---|---|
| `memory_note` | 主动记一笔。参数 `text`（一句话，60 字内）、`kind`（permanent / important / normal） |
| `memory_recall` | 按关键词翻旧账 |

`kind` 的差别：`permanent` 是身份、家人、长期偏好（永不遗忘）；`important` 是近期的事和约定（一个月）；
`normal` 是一般信息（一周）。

---

## 人设

| 工具 | 用途 |
|---|---|
| `persona_list` | 看有哪些人设可选 |
| `persona_switch` | 换一套（下一轮生效） |

---

## 其它

- `qq_get_recent_messages` / `qq_get_unread_messages` — 看最近的消息
- `qq_send_message` — 发消息（`messages` 传字符串=一条，传数组=多条）
- `qq_reply` — 回复某条
- `qq_get_prompt` — 看自己当前的角色卡
