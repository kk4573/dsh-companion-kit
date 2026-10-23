# dsh-companion-qq

给陪伴体接上 QQ：**自动启停 SnowLuma 与桥进程，带健康守护**。

它不管消息怎么收发（那是桥的事），只保证「那两个东西活着」。

## 安装

```bash
dsh plugin --profile web add dsh-companion-qq
```

在 profile 的 `cordis.patch.yml` 里指路径：

```yaml
- id: companion-qq
  name: 'dsh-companion-qq'
  config:
    snowlumaDir: 'D:/lab/vendor/SnowLuma'      # 含 launcher.bat
    bridgeDir: 'D:/lab/upstream/qq-bridge'      # 含 src/bridge.js
    bridgePort: 3100
    dshBaseUrl: 'http://127.0.0.1:3080'
```

> 路径必须显式给。插件装在 `node_modules` 里，按 `import.meta.url` 往上推只会得到 profile 目录，推不出你的项目目录。

## 它做什么

1. **启动时**：检查 SnowLuma（5099 / 3000 / 3001）和桥（3100）是否在跑，没跑就拉起来
2. **每 5 分钟**：做一次健康检查，挂了就重启
3. **连续失败 3 次**：进入退避（5 → 15 → 30 分钟），避免无限重试刷日志、弹窗口
4. **进程只杀自己拉起的**：你手动启动的不会被插件关掉

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `snowlumaDir` | `<lab>/vendor/SnowLuma` | SnowLuma 目录 |
| `bridgeDir` | `<lab>/upstream/qq-bridge` | 桥目录 |
| `bridgePort` | `3100` | 桥端口 |
| `healthIntervalMs` | `300000` | 检查间隔（5 分钟） |
| `maxConsecutiveFailures` | `3` | 连续失败几次后进入退避 |
| `backoffMinutes` | `[5,15,30]` | 退避梯度 |
| `dshBaseUrl` | `http://127.0.0.1:3080` | DSH 地址（桥要调它） |

## 状态口

```
GET /companion-qq/status
```

返回：

```json
{
  "ok": true,
  "failures": 0,
  "owned": [],
  "snowluma": [true, true, true],
  "bridge": true,
  "dsh": true
}
```

`owned` 是插件自己拉起的子进程 PID；`snowluma` 三个布尔值对应 5099 / 3000 / 3001。

## 已知限制

- **SnowLuma 必须在 QQ 已登录时启动**：QQ 没登录时启动，面板会活但 OneBot 的 3000/3001 不会初始化。插件会等 60 秒，等不到就放弃（下次检查再来）。
- **Windows only**（当前）：启动 SnowLuma 用 `cmd /c launcher.bat`。
- 插件重启 DSH 时不会自动关子进程（它们是被 DSH 拉起的，DSH 死了它们还在）。

## 许可

MIT
