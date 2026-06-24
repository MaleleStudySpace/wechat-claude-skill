# iLink Bot API 文档（基于 wechat.ts / auth.ts 总结）

本文档是基于本项目（`wechat-claude-skill`）实际调用 iLink Bot API 的实现总结，记录每个端点、字段、错误码、以及踩过的坑。**非官方文档**，仅面向本项目维护者和后续开发者。

## 0. 概览

| 项目 | 说明 |
|---|---|
| Base URL | `https://ilinkai.weixin.qq.com` |
| 协议 | HTTPS + JSON |
| 认证 | `Authorization: Bearer <botToken>` + `AuthorizationType: ilink_bot_token` |
| 通信模型 | 全 POST，表单/Body/JSON 三种风格混用（见下文） |
| 应用身份 | `iLink-App-Id: bot` / `iLink-App-ClientVersion: 131584` |
| 持久化状态 | `~/.wechat-claude-skill/sync_buf.json`（长轮询 cursor） |

### 0.1 通用请求头

所有请求都带：

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36
Accept: application/json, text/plain, */*
Accept-Language: zh-CN
Origin: https://ilinkai.weixin.qq.com
Referer: https://ilinkai.weixin.qq.com/
Authorization: Bearer <botToken>
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <base64(4 字节随机)>        // 每个请求新生成
iLink-App-Id: bot
iLink-App-ClientVersion: 131584            // (2<<16)|(2<<8)|0
```

> ⚠️ **`X-WECHAT-UIN` 必须每个请求都不一样**。如果固定不变或缺失，iLink 会判定为重放攻击并返回错误。代码里 `generateUin()` 每个请求都 `crypto.getRandomValues` 一次。

### 0.2 通用 Body 协议

所有 POST 都自动注入：

```json
{
  "base_info": { "channel_version": "2.2.0" }
}
```

> ⚠️ **不要省掉 `base_info.channel_version`**。实测少这个字段直接返回空响应/参数错误。版本号 `2.2.0` 是从 hermes-agent 沿用下来的，并不需要严格匹配本项目实际版本。

### 0.3 错误码速查

| ret | errcode | 含义 | 本项目处理 |
|---|---|---|---|
| `0` 或 `undefined` | `0` 或 `undefined` | 成功 | — |
| `-2` | — | 限流（rate-limited） | 指数退避重试，最多 3 次，延迟 3s → 6s → 12s，封顶 15s |
| `-14` | — | 会话过期（**注意：同名另一台设备登录同一微信导致 token 失效**） | 触发自动解绑（删除 token、移除 hook、清状态、提示用户重绑） |
| 其他 | 其他 | 通用错误 | 直接返回错误，不再重试 |

> ⚠️ **`ret=-14` ≠ 服务端踢下线**。ret=-14 几乎都意味着**同一个微信号在另一台设备/客户端登录了**，原来的 token 即刻失效。本项目在 `bridge.ts` 监听该信号，调用 `autoUnbind()` 让用户重新扫码。

---

## 1. QR 登录二段式（auth.ts 全流程）

### 1.1 /ilink/bot/get_bot_qrcode

请求生成二维码，扫码之前必须先拿到 `qr_code` 字符串。

- **方法**：POST
- **Body**：
  ```json
  {
    "type": "bot_login",
    "base_info": { "channel_version": "2.2.0" }
  }
  ```
- **响应**：
  ```json
  {
    "qr_code": "https://ilinkai.weixin.qq.com/xxxxx?token=...",
    "qrcode_url": "同上",        // 部分版本返回
    "expire": 600               // 二维码有效期（秒）
  }
  ```
- **关键字段**：`qr_code`（实际拼二维码的 URL，会被前端拿来渲染）
- **失败**：返回 `errcode` 非 0 时，前端应该弹窗重试

### 1.2 /ilink/bot/get_qrcode_status

轮询二维码状态，等待用户扫码确认。

- **方法**：POST
- **Body**：
  ```json
  {
    "type": "bot_login",
    "qr_code": "<上一步的 qr_code>",
    "base_info": { "channel_version": "2.2.0" }
  }
  ```
- **响应状态枚举**（从 auth.ts 的轮询逻辑推断）：
  | status | 含义 | 处理 |
  |---|---|---|
  | `waiting` / 0 | 二维码已生成，等待扫码 | 继续轮询 |
  | `scanned` / 1 | 用户已扫，手机端待确认 | 继续轮询 |
  | `confirmed` / 2 | 用户已确认 | 提取 token，进入下一步 |
  | `expired` / -1 | 二维码超时 | 回到步 1.1 重发 |
- **确认成功时的关键字段**：
  ```json
  {
    "status": "confirmed",
    "account_info": {
      "bot_token": "<your-bot-token>",
      "ilink_user_id": "<your-account-id>",
      "expire_time": 0,
      "nickname": "..."
    },
    "user_info": {
      "ilink_user_id": "<对方（即扫码者）ID>",
      "nickname": "...",
      "role": 3
    }
  }
  ```
- **关键字段**（auth.ts 实际依赖）：
  - `bot_token` → 之后 `Authorization: Bearer ...` 用的 token
  - `account_info.ilink_user_id` → 自己的账号 ID（**之后发送消息时的 `from_user_id`**）
  - `user_info.ilink_user_id` → 对方（扫码人）的 ID（**之后发送消息时的 `to_user_id`**）
- **轮询节奏**：建议 2~3 秒一次，太快可能被风控。

### 1.3 落盘

登录成功后写入 `~/.wechat-claude-skill/account.json`：

```json
{
  "botToken": "<bot_token>",
  "accountId": "<自己的 ilink_user_id>",
  "toUserId": "<扫码者的 ilink_user_id>",
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "nickname": "<昵称>"
}
```

> ⚠️ `toUserId` 是**扫码确认那一刻的目标用户**，不是真的"我订阅了所有消息"。多人群、多窗口时记得动态维护 `toUserId`。

> ⚠️ **同一个微信号在另一台设备/客户端二次登录时**，本机的 `account.json` 里的 `botToken` 会立刻失效。再次使用会触发 ret=-14。本项目把这个当作自动解绑信号（见 §6）。

### 1.4 QR 登录踩坑清单

1. **不要相信 `start "" "URL"` 永远能打开浏览器**：有概率启动 explorer 而非默认浏览器。`auth.ts` 当前用的是 `exec('start "" "${qrcodeUrl}"')`（走 cmd shell）。
2. **轮询超时控制**：默认 30 秒超时。命中超时返回非 0 时直接进入"重新生成 QR"分支。
3. **`MAX_RETRIES=3`**：auth.ts 限制最多尝试 3 次，三次都失败就让用户手动重试，避免无限重试导致扫码瘫痪。
4. **二次重试时清空状态**：从 RETRY 信号恢复时，auth.ts 会重新调用 `get_bot_qrcode`，避免使用旧的 `qr_code`。

---

## 2. /ilink/bot/getupdates（长轮询拉取消息）

**最常用的接口**。bridge.ts 持续在调用它，每 ~30 秒一次。

- **方法**：POST
- **超时**：30 秒（`POLL_TIMEOUT_MS=30000`）——服务器在无消息时会一直挂到这个时长，刚好被客户端超时断开。
- **Body**：
  ```json
  {
    "get_updates_buf": "<上一次的 sync cursor>",
    "base_info": { "channel_version": "2.2.0" }
  }
  ```
- **响应**：
  ```json
  {
    "ret": 0,
    "errcode": 0,
    "errmsg": "ok",
    "msgs": [ ... 消息数组 ... ],
    "get_updates_buf": "<新的 sync cursor>",
    "continue_flag": 1,
    "svr_time": 1719148800
  }
  ```

### 2.1 消息字段映射

服务端 `msgs[i]` 字段（部分）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `msg_id` | string | 消息 ID（用于去重） |
| `newMsgId` / `tempMsgId` | string | 同义词 |
| `message_type` / `msg_type` | int | `1`=用户 `2`=机器人自己 `3`=系统 |
| `from_user_id` | string | 发送者 ID |
| `from_nickname` | string | 昵称 |
| `from_role` | int | `2`=成员 `3`=群主 |
| `to_user_id` / `my_user_id` | string | **当前 bot 自己**的 ID（用于 @ 检测）|
| `create_time` | int64 | 毫秒时间戳 |
| `item_list` | array | 消息内容项 |
| `at_list` | array | @ 名单 |
| `context_token` | string | 用于回复时校验上下文 |

### 2.2 item_list 元素类型

| type | 字段 | 说明 |
|---|---|---|
| `1` ITEM_TEXT | `text_item.content` 或 `.text` | 文本内容 |
| `2` ITEM_IMAGE | — | 图片（直接渲染为 `【图片】`） |
| `4` ITEM_FILE | `file_item.name` | 文件名 |
| `10` ITEM_LINK | `link_item.title` / `.link` | 卡片链接 |
| `17` ITEM_CARD | `card_item.title` / `.desc` | 富卡片 |

### 2.3 cursor 持久化

每次返回的 `get_updates_buf` 立即落地到 `~/.wechat-claude-skill/sync_buf.json`：

```json
{ "get_updates_buf": "..." }
```

> ⚠️ **重启后第一件事是 load 这玩意**。`startMessagePolling()` 启动时调 `loadSyncBuf()` 把上次未消费的 cursor 喂回去，避免漏消息。
>
> ⚠️ **如果 sync_buf 损坏或者丢失**，相当于把"未读"清空——可能会丢那一两条滚过去的消息，但不会致命。新启动的轮询会从当前开始往后走。

---

## 3. /ilink/bot/sendmessage（发消息）

发文本消息。带每用户限流 + 指数退避重试。

- **方法**：POST
- **Body 包装**：
  ```json
  {
    "msg": { ... 实际消息对象 ... },
    "base_info": { "channel_version": "2.2.0" }
  }
  ```
- **msg 字段**：
  ```json
  {
    "from_user_id": "<bot 自己>",
    "to_user_id": "<目标用户>",
    "client_id": "wcc-<ts>-<rand>",
    "message_type": 2,        // MSG_TYPE_BOT
    "message_state": 2,       // MSG_STATE_FINISH
    "item_list": [
      { "type": 1, "text_item": { "text": "..." } }
    ],
    "context_token": "<可选，来自 getupdates 的字段>"
  }
  ```

### 3.1 限流与重试

- **每用户发送间隔**：`MIN_SEND_INTERVAL_MS = 2500`（同一 `to_user_id` 之间至少 2.5 秒）。
- **重试触发条件**：`ret === -2`。
- **重试节奏**：`SEND_RETRY_DELAY_MS = 3000`，每次翻倍，封顶 15 秒。**最多 3 次**。
- **重复发送配额**：失败重试时把 `nextSendTime` 推迟（避免短时间反复被打回）。

### 3.2 context_token 的妙用/坑用

- 来自 `getupdates` 的 `context_token` 字段，用于"回复上下文中那条具体消息"。
- 第一次发送时如果带 `context_token`，遇到 `errcode=-14`（session expired）：
  - 代码会**剥掉 context_token** 再重试一次（只一次），因为带它容易和服务端校验不一致。
  - 仍失败则抛回上层。

> ⚠️ **手动构造的 context_token 没用**：context_token 必须由 pull 收到对方消息后从 `msgs[i].context_token` 拿，否则服务端校验直接 ret=-14。

### 3.3 成功响应

读 `json.ret === undefined || json.ret === 0`，且 `errcode === undefined || errcode === 0`：

```json
{ "ret": 0, "errcode": 0, "resp": { "msg_id": "..." } }
```

失败重试看 `errcode`：
- `errcode === -14`：session expired，剥上下文再试一次。
- `ret === -2`：限流，退避重试。
- 其他：直接抛错，不再重试。

---

## 4. /ilink/bot/sendtyping（输入提示）

发"正在输入..."提示，UI 增强用。

- **方法**：POST
- **Body**：
  ```json
  {
    "ilink_user_id": "<to_user_id>",
    "typing_ticket": "<ticket>",
    "status": 0,
    "base_info": { "channel_version": "2.2.0" }
  }
  ```
- `status`: `0`=结束 typing，`1`=开始 typing。
- 失败被忽略，不重试也不报错。

> 📝 本项目目前并没有调用 sendtyping（`sendTyping()` 函数虽然保留，但未被任何调用方使用）。后续如果要做"Claude 在思考中"的体验可以接上。

---

## 5. 完整交互时序图

```
┌──────────┐                  ┌──────────────┐               ┌──────────────┐
│  CLI/IDE │                  │ wechat-claude│               │   iLink  API │
└────┬─────┘                  └──────┬───────┘               └──────┬───────┘
     │ /wechat 启动                  │                              │
     │──────────────────────────────►│                              │
     │                               │ 1. POST get_bot_qrcode       │
     │                               │─────────────────────────────►│
     │                               │◄──────── qr_code ───────────│
     │ ◄──── 打开 QR 图片 ───────────│                              │
     │                               │ 2. POST get_qrcode_status (轮询 2~3s)
     │                               │─────────────────────────────►│
     │                               │◄──── status=waiting ─────────│
     │ [用户手机扫码确认]            │                              │
     │                               │─────────────────────────────►│
     │                               │◄──── status=confirmed ───────│
     │                               │ 落盘 account.json            │
     │ ◄────success─────────────────│                              │
     │                               │ 3. POST getupdates (★ 长轮询循环，每 30s)
     │                               │─────────────────────────────►│
     │                               │◄──── msgs / continue ────────│
     │ ◄──── 消息进 Claude ──────────│                              │
     │                               │ 4. POST sendmessage          │
     │                               │─────────────────────────────►│
     │                               │◄──── ret=0 ──────────────────│
```

---

## 6. **关键注意事项（踩坑汇总）**

### 6.1 ⚠️ 同一个微信号异地登录导致 token 失效

**现象**：用户反馈"微信用户要时隔1、2个小时就要主动回复，不然就会被判定为断开。无法通过ilink发送消息。这时候只要微信用户主动回复一下消息就可以了"。

**实际情况**：
- iLink **不会主动踢下线**连接。
- 但服务端会判定"长时间（1~2 小时）无互动"为"无人在线"，并把 bot 状态置为离线。
- 离线状态下 `sendmessage` 会返回 `ret=-14`（session_expired）。
- 用户在微信端**主动回复一条消息**，相当于重新激活会话。
  - 有些情况下服务端会自动恢复 token，需要再试一次 `sendmessage` 才会被接受。
  - 有些情况下需要重新走 §1 的 QR 流程拿到新 token。

**本项目处理**（`bridge.ts` 的 `autoUnbind`）：
- 一旦 `sendmessage` 或 `getupdates` 收到 `errcode=-14`：
  1. 删除 `~/.wechat-claude-skill/account.json`（token 已废）。
  2. 删除 `~/.claude/settings.json` 里本项目注册的 hook（避免僵尸 hook 试图往不存在的会话写）。
  3. 删除 `state.json` / `bridge.pid` / `pty.pid` 等残留 pid。
  4. 在 CLI 终端打印 `⚠️ 微信绑定已失效，已自动解绑。请执行 /wechat 重新绑定。`。
  5. 退出 bridge 子进程。

**为什么不"无感续期"**：
- 用户在另一台电脑/手机重新登录后，原 token 是真的失效，没有续期 API。
- 必须重新扫码才能拿到新 token，所以问题退化到"要不要自动弹出 QR"。
- 目前的设计选择是：宁可让用户走一次 `/wechat`，也不要让 bridge 在后台偷偷弹窗打扰。

### 6.2 ⚠️ `X-WECHAT-UIN` 必须每次随机

固定或缺失会被服务端判定为重放攻击。randomUin() 用 `crypto.getRandomValues(new Uint8Array(4))` 生成 4 字节随机再 base64。

### 6.3 ⚠️ `base_info.channel_version` 不要省

`"2.2.0"` 是从 hermes-agent 沿用的常量字段，缺失会触发 ret=-1/参数错误封包。它与本项目实际版本号无关。

### 6.4 ⚠️ 限流 -2 与过期 -14 不要混淆

| ret | 含义 | 错误的处置 |
|---|---|---|
| `-2` | 限流 | **绝不能当过期处理**，否则会直接停发。正确做法是退避重试 3 次。 |
| `-14` | session expired | 不能退避重试，因为根本不可能自愈（除非用户主动回复，否则必须重新走 QR）。 |

老代码里 `isStaleSession()` 一度把 ret=-2 当过期处理，导致发 1 条就停。**已被显式纠正**：只有 `errcode === -14` 才判过期。

### 6.5 ⚠️ 消息去重靠 msg_id

为了防止长轮询重复投递，`startMessagePolling` 维护 `recentMsgIds: Set<string>`（1000 条上限，超半数时淘汰最老）。同一 `msg_id` 不会让 callback 触发两次。

### 6.6 ⚠️ Polling 错误退避

连续失败 ≥3 次时把间隔从 3 秒抬到 30 秒（`BACKOFF_LONG_MS=30000`），避免 nest 死循环轰炸服务端。失败计数在收到任何成功响应后归零。

### 6.7 ⚠️ 长消息拼接

服务端把多个 `item_list` 项用换行串成 text；项目中也模仿这种拼接。**注意**：如果你直接读 `msg.text`，会拿到已经拼好的多行文本，**不要再 split**。

### 6.8 ⚠️ "at 我" 的判定

判断一条消息是不是 @bot，需要：
- `at_list[i].at_user_id === raw.my_user_id`
- `my_user_id` 来自消息体本身的 `to_user_id` / `my_user_id` 字段
- 不要拿全局 cache 的 bot ID 去比对——大多数消息里 `my_user_id` 字段才是权威。

### 6.9 ⚠️ 文本清理

parse 阶段会 `.replace(/@imᐸ/g, '').trim()` 去掉客户端的@装饰后缀。如果你的下游依赖原始文本，请读到的 `msgs[i].item_list[0].text_item.text` 而不是 `msg.text`。

### 6.10 ⚠️ 不要在 sendmessage 里塞太多并发

每个 `to_user_id` 都有 2.5s 间隔。多用户同时发消息会被自家限流器对齐到串行。桥接 Claude 答非所问多条并发回信时也只会按顺序出。

### 6.11 ⚠️ sendmessage 失败的"静默期"

当连续 `ret=-2` 3 次都失败时，**`nextSendTime` 被推迟** `delay + 2500ms`。这段时间里调用 `sendMessage` 不会立刻发，会先 sleep。这是保护机制，但要注意：如果你希望"用户主动发了消息立即生效"，不要因为这个 sleep 把响应时间拖长。

### 6.12 ⚠️ Polling/发送的失败 = 不致命

`fetchMessages` 失败时返回空数组而不抛异常——这是**正确**的设计：网络抖动不该让 bridge 死。bridge 退出只发生在 `autoUnbind` 或 SIGTERM 信号时。

---

## 7. 不开放/未实现的端点

当前未实现但 iLink 提供的端点（保留扩展空间）：

- `/ilink/bot/sendtyping` —— 已封装，未使用。
- 图片/文件/卡片发送 —— 当前 msg item 只构建了 ITEM_TEXT。`item_list` 用同样的格式支持其他 `type` 字段即可发送，但本项目用不上。
- 群消息 / 多人对话 —— 同样是 `from_user_id`/`to_user_id` 模型，但要解决 `toUserId` 不是单值的问题。

## 8. 调试 tips

1. **抓包**：所有请求体的 `base_info` 与 `X-WECHAT-UIN` 都打开看一下，缺失任何一个就立刻报错。
2. **日志**：`~/.wechat-claude-skill/bridge.log` 是 bridge polling 的唯一持续日志。bridge 启动参数 `--debug` 会再开 console 日志。
3. **手动调 token**：
   ```bash
   curl -X POST https://ilinkai.weixin.qq.com/ilink/bot/getupdates \
     -H "Authorization: Bearer <token>" \
     -H "AuthorizationType: ilink_bot_token" \
     -H "X-WECHAT-UIN: $(head -c4 /dev/urandom | base64)" \
     -H "iLink-App-Id: bot" -H "iLink-App-ClientVersion: 131584" \
     -H "Content-Type: application/json" \
     -d '{"get_updates_buf":"","base_info":{"channel_version":"2.2.0"}}'
   ```
   如果返回 `ret=0` 代表 token 还有效；如果返回 `errcode=-14` 立刻触发自动解绑。
4. **检测是不是"半断"状态**：bridge 看起来健康、轮询也成功，但 sendmessage 一直 -14。**这时候是服务端把会话判过期了**，用户必须在微信主动发一条消息才能恢复。

---

> 这份文档基于 `src/wechat.ts`、`src/auth.ts`、`src/config.ts` 的当前实现总结。如果发现 iLink 服务端行为有变，请同步更新本文。
