# Home Assistant 配置指南

本文档描述如何在 Home Assistant 中配置 Pi Proxy 集成。AI 可以根据此文档自动完成 HA 侧的全部配置。

## 前置条件

- pi-proxy 服务已启动并监听（默认 `http://<PI_HOST>:8787`）
- HA 能通过网络访问 pi-proxy（局域网可达）
- 已知 pi-proxy 的访问令牌（`token`）

## 文件清单

`pi-ha/` 目录包含以下文件，每个文件对应 HA 配置的一个独立部分：

| 文件 | 作用 | 写入位置 |
|------|------|----------|
| `rest_commands.yaml` | REST 命令：让 HA 向 pi-proxy 发送指令 | `configuration.yaml` 顶层 |
| `rest_sensors.yaml` | REST 传感器：HA 定期轮询 pi-proxy 获取状态和回复 | `configuration.yaml` 顶层 |
| `template_sensors.yaml` | 模板传感器：合并多个数据源，统一展示任务状态 | `configuration.yaml` 顶层 |
| `input_helpers.yaml` | 输入辅助：存储用户指令和 webhook 通知缓存 | `configuration.yaml` 顶层 |
| `automations.yaml` | 自动化：接收 pi-proxy 的 webhook 回调 | `automations.yaml` |

## 配置步骤

### 步骤 1：替换变量

在所有文件中，需要替换以下变量为你的实际值：

| 变量 | 说明 | 示例 |
|------|------|------|
| `<PI_PROXY_HOST>` | pi-proxy 的地址和端口 | `192.168.1.100:8787` |
| `<HA_HOST>` | HA 主机的 IP 地址（webhook 回调目标） | `192.168.1.200` |
| `<YOUR_TOKEN>` | pi-proxy 的访问令牌（对应 config.json 的 `token`） | `my-secret-token-123` |

### 步骤 2：修改 configuration.yaml

将以下四个文件的内容**依次追加**到 HA 的 `configuration.yaml` 中：

```
configuration.yaml
├── （原有内容保留不动）
├── ← rest_commands.yaml 的内容
├── ← rest_sensors.yaml 的内容
├── ← template_sensors.yaml 的内容
└── ← input_helpers.yaml 的内容
```

**注意**：如果 `configuration.yaml` 中已有 `rest_command:`、`rest:`、`template:` 或 `input_text:` 段，需要将新内容**合并**到已有的段下面，而不是重复创建段名。例如：

```yaml
# 已有的 rest_command
rest_command:
  existing_command:
    url: "..."

  # 追加 pi-proxy 的命令
  pi_prompt:
    url: "http://..."
```

### 步骤 3：修改 automations.yaml

将 `automations.yaml` 中的内容追加到 HA 的 `automations.yaml` 文件末尾。

如果 HA 的 `automations.yaml` 已有其他自动化，直接追加即可（每条自动化以 `- id:` 开头）。

确保 `configuration.yaml` 中有这一行（通常默认就有）：

```yaml
automation: !include automations.yaml
```

### 步骤 4：重启 Home Assistant

配置修改后需要重启 HA 使其生效。

## 各文件详细说明

### rest_commands.yaml — REST 命令

定义三个 HTTP 命令，让 HA 可以控制 pi-proxy：

- **`pi_prompt`**：向 Pi 发送指令。使用 `streamingBehavior: "followUp"` 让指令排队等待（Pi 的 `steeringMode` 是 `one-at-a-time`，同时只能处理一个任务）。`wait: false` 表示立即返回，不阻塞 HA。
- **`pi_abort`**：中止 Pi 当前正在执行的任务。
- **`pi_status`**：手动查询 Pi 状态（通常不需要，REST 传感器会自动轮询）。

调用方式（在自动化或脚本中）：

```yaml
service: rest_command.pi_prompt
data:
  message: "帮我查一下今天的天气"
```

### rest_sensors.yaml — REST 传感器

定义两个轮询端点，定期从 pi-proxy 拉取数据：

**`/last`（每 15 秒）**：
- 创建传感器 `sensor.pi_last_reply`
- 获取 Pi 的最新回复文本
- 截断到 255 字符（HA state 字段上限）
- 作为 webhook 回调的兜底数据源

**`/status`（每 5 秒）**：
- 创建传感器 `sensor.pi_is_streaming`（Pi 是否正在输出）
- 创建传感器 `sensor.pi_message_count`（当前会话消息数）
- 创建传感器 `sensor.pi_running`（pi-proxy 服务是否存活）
- 用于实时展示"正在执行中"状态

**为什么需要两个轮询频率？**
- `/status` 5 秒一次：状态变化频繁，需要较快响应，让用户及时看到"正在执行"
- `/last` 15 秒一次：回复内容变化不频繁，且主要依赖 webhook 即时推送，轮询只是兜底

### template_sensors.yaml — 模板传感器

创建 `sensor.pai_task_status`（"Pai 任务状态"），将多个传感器的数据合并成一个易读的状态描述。

**优先级逻辑**（从高到低）：

```
if isStreaming == true:
    → "正在执行中，消息数: X"           （数据来自 /status 轮询）
elif input_text.pai_latest_notification 有效:
    → "空闲待命，消息数: X，上次: ..."   （数据来自 webhook 回调，优先级最高）
elif sensor.pi_last_reply 有效:
    → "空闲待命，消息数: X，最近回复: ..."（数据来自 /last 轮询，兜底）
else:
    → "空闲待命，消息数: X"
```

### input_helpers.yaml — 输入辅助

定义两个文本输入字段：

- **`input_text.pi_instruction`**：用户在 HA 界面手动输入的指令文本（可选用途）。
- **`input_text.pai_latest_notification`**：webhook 回调写入的通知缓存。格式为 `[HH:MM:SS] 原始指令 → 回复内容`，最大 255 字符。

### automations.yaml — Webhook 自动化

当 pi-proxy 完成 Pi 的任务后，会向 HA 发送 webhook 回调：

```
POST http://<HA_HOST>:8123/api/webhook/pi_task_completed
Body: { "text": "回复内容", "prompt": "原始指令", "timestamp": "2026-09-28 17:17:26" }
```

本自动化接收这个回调，将信息格式化后写入 `input_text.pai_latest_notification`，供模板传感器展示。

**格式化规则**：
- 时间戳取 `timestamp` 的 `HH:MM:SS` 部分
- 原始指令截取前 30 个字符
- 回复内容填充剩余空间
- 总长度不超过 255 字符

**示例输出**：`[17:17:26] 帮我写一篇小学生作文 → 已写好约2000字作文，保存在...`

## 数据流总览

```
用户语音/文本
    ↓
小智AI / HA 界面
    ↓
rest_command.pi_prompt → pi-proxy POST /prompt
    ↓
Pi Agent 执行任务
    ↓
┌─────────────────────────────────────────────┐
│  通道 1：Webhook 回调（即时推送）              │
│  pi-proxy → POST /api/webhook/pi_task_completed │
│  → automations.yaml → input_text.pai_latest_notification │
├─────────────────────────────────────────────┤
│  通道 2：REST 轮询（兜底）                     │
│  HA 每 15 秒 GET /last → sensor.pi_last_reply │
├─────────────────────────────────────────────┤
│  通道 3：状态轮询（实时进度）                   │
│  HA 每 5 秒 GET /status → sensor.pi_is_streaming │
└─────────────────────────────────────────────┘
    ↓
template sensor "Pai 任务状态" 按优先级展示
    ↓
用户通过小智AI / HA 界面查看结果
```

## 验证配置

重启 HA 后，检查以下内容：

1. **传感器是否创建成功**：在 HA 开发者工具中搜索 `pi_last_reply`、`pi_running`、`pai_task_status`
2. **REST 命令是否可用**：在开发者工具 → 服务中搜索 `pi_prompt`
3. **Webhook 是否注册**：在开发者工具 → 事件中监听 `pi_task_completed`
4. **端到端测试**：调用 `rest_command.pi_prompt` 发送一条指令，观察传感器是否更新

```yaml
# 开发者工具 → 服务 调用示例
service: rest_command.pi_prompt
data:
  message: "只回复两个字：收到"
```

## 故障排查

| 问题 | 检查项 |
|------|--------|
| 传感器显示 `unavailable` | pi-proxy 是否运行？HA 能否访问 `http://<PI_HOST>:8787/healthz`？ |
| 回复不更新 | 检查 token 是否正确；查看 HA 日志中 REST 传感器的错误 |
| Webhook 不触发 | 检查 pi-proxy `config.json` 的 `webhookUrl` 是否指向正确的 HA 地址 |
| 状态一直显示"正在执行中" | Pi 可能卡住了，调用 `rest_command.pi_abort` 中止 |
| 回复被截断 | 正常行为，HA state 限制 255 字符；检查 `AGENTS.md` 中的字符限制指令是否生效 |
