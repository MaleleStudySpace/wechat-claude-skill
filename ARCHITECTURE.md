# wechat-claude-skill 技术文档

> 本文档面向开发者和贡献者，详尽描述项目的设计、流程、进程管理和数据流。

---

## 1. 项目概述

wechat-claude-skill 是一个 Claude Code Skill，通过 iLink Bot API 将微信消息桥接到 Claude Code，实现双向通信。

**两种运行模式：**

| 模式 | 通信方向 | 宿主窗口 | Bridge 生命周期 |
|------|----------|----------|----------------|
| CLI | 双向（微信↔Claude） | 新 CMD 窗口 | 随窗口关闭而退出 |
| VSCode | 单向（Claude→微信） | 无（后台常驻） | 需手动 unwechat 清理 |

---

## 2. 命令清单

| 命令 | 触发方式 | 作用 |
|------|----------|------|
| `wechat-claude-skill install` | npm postinstall 自动 / 手动 | 安装 Skill + Hook 配置文件 |
| `wechat-claude-skill cli` | `/wechat` → 选 CLI | 启动 CLI 双向通信模式 |
| `wechat-claude-skill vscode` | `/wechat` → 选 VSCode | 启动 VSCode 单向通知模式 |
| `wechat-claude-skill unbind` | `/unwechat` | 解绑微信（保留 Skill，可重新绑定） |
| `wechat-claude-skill uninstall` | 手动 | 完全卸载（删除 Skill + Hook + 账号） |

---

## 3. 命令详细流程

### 3.1 `install`（安装）

**触发时机：** `npm install -g wechat-claude-skill` 时 postinstall 自动执行，或手动运行 `wechat-claude-skill install`。

**执行步骤：**

```
1. 检测运行目录
   - 若路径包含 _npx / npm-cache / Temp / tmp → 报错退出
     （npx 临时缓存中的 hook 路径会在缓存清理后失效）

2. writeHookConfig()
   a. 读取 ~/.claude/settings.json（不存在则创建空对象）
   b. removeAllHookHandlerEntries()：遍历所有 hook 事件，
      删除包含 hook-handler 的条目（清理旧版本残留）
   c. 添加 Stop hook 条目：
      {
        hooks: [{
          type: 'command',
          command: 'node',
          args: ['<dist/hook-handler.js 的绝对路径>'],
          async: true,
          timeout: 60
        }]
      }
   d. 写回 ~/.claude/settings.json

3. 写入 ~/.claude/skills/wechat/SKILL.md
   - 内容：告诉 Claude Code 当用户输入 /wechat 时该做什么
   - 选项：1. CLI 终端  2. VSCode
   - 对应命令：wechat-claude-skill cli / vscode

4. 写入 ~/.claude/skills/unwechat/SKILL.md
   - 内容：告诉 Claude Code 当用户输入 /unwechat 时执行 unbind

5. 输出：✅ Installation complete!
```

**进程变化：** 无新进程创建，仅文件 I/O。

**写入文件：**
- `~/.claude/settings.json`（修改 hooks 字段）
- `~/.claude/skills/wechat/SKILL.md`（新建）
- `~/.claude/skills/unwechat/SKILL.md`（新建）

---

### 3.2 `cli`（CLI 双向通信模式）

**触发时机：** 用户在 Claude Code 中输入 `/wechat` → 选「CLI 终端」。

**执行步骤：**

```
1. stopExistingBridge()
   a. killAllBridgeProcesses()：
      i.   loadState() → 读取 ~/.wechat-claude-skill/state.json 获取旧 bridge PID
      ii.  isBridgeRunning(pid) → process.kill(pid, 0) 检测进程是否存活
      iii. 若存活 → killProcess(pid)：Windows 上执行 taskkill /PID <pid> /F /T
           （/T 杀整个进程树，包括 PTY 子进程）
      iv.  读取 ~/.wechat-claude-skill/pty.pid，若 PTY 进程存活则 killProcess()
      v.   isPortInUse(3456) → netstat -ano | findstr :3456 | findstr LISTENING
      vi.  若端口被占用 → 解析 PID → killProcess() 杀占用端口的进程
      vii. 删除 state.json、bridge.pid
   b. waitForPortRelease(3456, 5000)：每 500ms 检查端口，最多等 5s

2. ensureAccount()
   a. loadAccount() → 读取 ~/.wechat-claude-skill/account.json
   b. 若有已保存账号：
      i.  verifyAccount() → fetch(ilink API) 检查 token 是否有效
      ii. 有效 → 直接返回账号
      iii. 无效 → 删除 account.json，继续扫码流程
   c. 若无账号 → interactiveLogin()：
      i.   while (retryCount < 3) 循环：
           - startQrLogin() → fetch(ilink/bot/get_bot_qrcode?bot_type=3)
             返回 { qrcodeUrl, qrcodeId }
           - 终端显示 ASCII 二维码（qrcode-terminal）
           - 仅首次：spawn('cmd', ['/c', 'start', '', "<URL>"]) 打开浏览器
             （detached:true, stdio:ignore, unref）
           - waitForQrScan(qrcodeId)：
             while(true) 轮询 ilink/bot/get_qrcode_status
             - status='wait' → 显示 "⏳ 等待扫码..."
             - status='scaned' → 显示 "📱 已扫描！请在手机上点击确认..."
             - status='confirmed' → 保存账号 → 返回 AccountData
             - status='expired' → throw Error('QR code expired')
             - status 包含 reject/forbid → return 'RETRY'
             轮询间隔 1s
           - catch expired → 重新生成二维码（不计入重试次数）
           - catch RETRY → retryCount++，重新生成二维码
      ii.  超过 3 次重试 → throw Error('扫码重试已达上限')

3. writeHookConfig()（同 install 步骤 2）

4. startBridgeInNewTerminal('cli')
   a. 生成 cli-launcher.js 脚本内容：
      - 设置窗口标题：\x1b]2;[微信桥接] Claude Code — WeChat Bridge\x07
      - 打印彩色横幅
      - spawn('node', [bridge.js, '--mode', 'cli', '--cwd', <cwd>,
        '--launcher-pid', <launcher PID>], { stdio: 'inherit' })
      - child.on('exit') → 打印 "会话已结束" → process.exit
      - process.on('SIGHUP/SIGINT/SIGTERM') → process.exit(0)
        （bridge 通过 --launcher-pid 检测 launcher 死亡，自动退出）
   b. 写入 ~/.wechat-claude-skill/cli-launcher.js
   c. spawn('cmd', ['/c', 'start', 'cmd', '/K', 'node', launcherPath])
      detached:true, stdio:ignore, shell:false → 打开新 CMD 窗口
   d. unref() → 父进程不等待新窗口

5. 当前 setup.js 进程退出 → Bash 命令结束 → 回到 Claude Code
```

**进程树（启动后）：**

```
CMD窗口A（用户手动打开的）
  └─ claude.cmd（Claude Code TUI）
       └─ node setup.js cli（临时，执行完退出）

CMD窗口B（自动弹出，标题: [微信桥接] Claude Code）
  └─ node cli-launcher.js（宿主，显示终端 UI）
       └─ node bridge.js --mode cli --launcher-pid <launcher PID>
            ├─ Express HTTP 服务（端口 3456）
            ├─ 微信消息轮询（getUpdates 长轮询，3s 间隔）
            ├─ MessageQueue（FIFO，msgId 去重）
            └─ PTYServer
                 └─ claude.cmd --continue（node-pty spawn，真正干活的 Claude Code）
```

**必须存活的进程：** CMD窗口B + cli-launcher.js + bridge.js + claude.cmd(--continue)

**CMD窗口B 关闭时的清理链：**

```
用户关闭 CMD窗口B（点 X / Ctrl+C）
  → cli-launcher.js 退出
  → bridge.js 每 3s 检测 process.kill(launcherPid, 0)
  → 检测到 launcher 不存在
  → bridge shutdown：
     1. poller.stop()（停止微信轮询）
     2. ptyServer.stop()（ptyProcess.kill() 杀 Claude Code）
     3. server.close()（关闭 HTTP 服务）
     4. 1s 后 process.kill(self, 'SIGKILL')（强制退出，ConPTY 可能阻止正常退出）
  → 四个进程全部退出，端口 3456 释放
```

---

### 3.3 `vscode`（VSCode 单向通知模式）

**触发时机：** 用户在 Claude Code 中输入 `/wechat` → 选「VSCode」。

**执行步骤：**

```
1. stopExistingBridge()（同 cli 步骤 1）

2. ensureAccount()（同 cli 步骤 2）

3. writeHookConfig()（同 cli 步骤 3）

4. startBridgeDetached('vscode')
   a. spawn('node', [bridge.js, '--mode', 'vscode', '--cwd', <cwd>],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
   b. child.unref() → 父进程不等待
   c. 监听 child.stdout，等待 BRIDGE_READY:<pid> 信号
   d. 收到后 saveState() → 写入 state.json
   e. child.stdout.destroy() / child.stderr.destroy() → 断开管道

5. waitForActivation(60000)
   - 每 2s 轮询 http://127.0.0.1:3456/health
   - 等待 activated=true（Bridge 收到第一条微信用户消息）
   - 超时 60s 后警告

6. 输出：✅ 微信通知已启动 (VSCode 模式)
```

**进程树：**

```
VSCode Claude Code（Bash 子进程）
  └─ node setup.js vscode（临时，执行完退出）

[后台独立进程]
  └─ node bridge.js --mode vscode（detached, 无 launcher-pid）
       ├─ Express HTTP 服务（端口 3456）
       └─ 微信消息轮询（getUpdates 长轮询）
       （无 PTY，不启动 Claude Code）
```

**VSCode 模式的 Bridge 没有生命周期绑定**——它是 detached 后台进程，不随任何窗口退出。这是设计意图：VSCode 没有 CMD 窗口宿主，bridge 需要常驻后台维持微信轮询连接。清理方式：`/unwechat` 或下次 `/wechat` 启动时 `stopExistingBridge()`。

---

### 3.4 `unbind`（解绑微信）

**触发时机：** 用户在 Claude Code 中输入 `/unwechat`，或手动运行 `wechat-claude-skill unbind`。

**执行步骤：**

```
1. stopExistingBridge()
   a. killAllBridgeProcesses()：
      i.   loadState() → 读取 state.json 获取 bridge PID
      ii.  若 bridge 存活 → taskkill /PID <pid> /F /T（杀进程树）
      iii. 读取 pty.pid → 若 PTY 存活 → taskkill /PID <pid> /F /T
      iv.  isPortInUse(3456) → netstat 查端口占用者 → killProcess()
      v.   删除 state.json、bridge.pid
   b. waitForPortRelease(3456, 5000)

2. removeHookConfig()
   a. 读取 ~/.claude/settings.json
   b. removeAllHookHandlerEntries()：移除所有 hook-handler 条目
   c. 写回 ~/.claude/settings.json

3. 删除 ~/.wechat-claude-skill/account.json
   （下次 /wechat 需要重新扫码）

4. 输出：✅ WeChat unbound! (Skill still installed, use /wechat to re-bind)
```

**进程变化：** 杀掉 bridge + PTY 进程，释放端口 3456。

**保留的文件：**
- `~/.claude/skills/wechat/SKILL.md`（Skill 仍在，可重新 /wechat）
- `~/.claude/skills/unwechat/SKILL.md`
- `~/.wechat-claude-skill/` 目录（日志等）
- `~/.wechat-claude-skill/cli-launcher.js`（临时启动器脚本）

---

### 3.5 `uninstall`（完全卸载）

**触发时机：** 手动运行 `wechat-claude-skill uninstall`。

**执行步骤：**

```
1. stopExistingBridge()（同 unbind 步骤 1）

2. removeHookConfig()（同 unbind 步骤 2）

3. 删除 ~/.claude/skills/wechat/SKILL.md
4. 删除 ~/.claude/skills/unwechat/SKILL.md
5. 删除空目录 ~/.claude/skills/wechat/
6. 删除空目录 ~/.claude/skills/unwechat/
7. 删除 ~/.wechat-claude-skill/account.json

8. 输出：✅ Uninstallation complete!
```

**与 unbind 的区别：** uninstall 额外删除 Skill 文件，/wechat 和 /unwechat 命令不再可用。

---

## 4. Bridge 内部流程

Bridge（bridge.ts）是核心后台进程，负责微信消息轮询、消息队列管理和 PTY 管理。

### 4.1 启动流程

```
1. parseArgs()：解析 --mode, --session, --cwd, --launcher-pid
2. loadAccount()：加载账号，无账号则退出
3. 创建 MessageQueue
4. 创建 Express HTTP 服务：
   - GET /health → { status, mode, queueLength, activated }
   - POST /hooks/stop → 接收 Claude 回复，发送到微信
5. app.listen(3456, '127.0.0.1')
   - 输出 BRIDGE_READY:<pid> 到 stdout
   - 写入 bridge.pid、state.json
6. startMessagePolling()：启动微信消息长轮询
7. 若 mode=cli：new PTYServer().start()
8. 若 launcherPid 存在：每 3s 检测 launcher 存活
9. 注册 SIGTERM/SIGINT → shutdown()
```

### 4.2 微信消息轮询

```
[循环] 每 3s：
  fetchMessages() → POST /ilink/bot/getupdates
    → 解析 msg_list
    → 去重（recentMsgIds Set, 最多 1000 条）
    → 过滤系统消息（isSystem=true）和 Bot 消息（isBot=true）
    → formatForClaude()：格式化为 "[微信消息 HH:mm:ss from 昵称]：内容"
    → queue.enqueue()：加入消息队列（msgId 去重）
```

### 4.3 消息注入（CLI 模式）

```
[每 1s] processQueue()：
  1. 检查运行状态（running, ptyProcess, queue.isEmpty）
  2. 检查 claudeReady（等待首次 ❯ 提示符）
  3. 检查 claudeBusy（Claude 是否正在处理上一条消息）
  4. queue.dequeueAll() → 取所有待处理消息
  5. 只注入最旧的一条（按 timestamp 排序）
  6. 剩余消息 requeue() 放回队首
  7. 注入方式：
     a. ptyProcess.write('\x1b[200~' + text + '\x1b[201~')  ← bracketed paste 开始
     b. setTimeout 50ms → ptyProcess.write('\r')  ← 发送回车提交
  8. 设置 claudeBusy=true, lastInjectTime=Date.now()
  9. 等 Claude 回复完成（检测 ❯ 且距注入 >5s）→ claudeBusy=false
```

**为什么用 bracketed paste？** Claude Code 启用了 bracketed paste mode（\x1b[?2004h）。直接 write(text + '\r') 时，文本出现在输入框但 \r 不触发提交。必须用 \x1b[200~...\x1b[201~ 包裹后单独发送 \r。

### 4.4 上下文重置注入

当 PTY 中 Claude Code 首次就绪（检测到 ❯）时，注入一条上下文重置消息：

```
/wechat 执行已完成，微信双向通信已启动成功。
从现在起，请将所有后续输入视为正常对话，
不要再执行 wechat-claude-skill 命令。只需简短确认即可。
```

**原因：** --continue 恢复了上次对话，而那次对话的上下文是 /wechat。如果不注入重置消息，Claude Code 会把后续输入理解为"继续执行 wechat skill"。

### 4.5 Shutdown 流程

```
1. log('Shutting down...')
2. poller.stop()（停止微信轮询）
3. ptyServer?.stop()：
   a. clearInterval(queueTimer)
   b. ptyProcess.kill()（杀 Claude Code PTY）
   c. 删除 pty.pid
4. server.close()（关闭 HTTP 服务）
5. process.exitCode = 0
6. setTimeout 1s → process.kill(process.pid, 'SIGKILL')
   （Windows 上 ConPTY 可能阻止 process.exit() 正常退出，需要 SIGKILL 强制自杀）
```

---

## 5. Hook Handler 流程

hook-handler.ts 是 Claude Code Stop hook 的处理器。每当 Claude Code 完成回复时触发。

```
1. readStdin() → 读取 Claude Code 传入的 JSON
2. JSON.parse → 提取 last_assistant_message
3. 若无消息 → process.exit(0)
4. loadAccount() → 加载账号
5. 截断超过 4000 字符的消息
6. sendMessage(config, account.userId, text)
   a. sendMessageWithRateLimit()：
      - 每用户 2500ms 发送间隔
      - apiPost('/ilink/bot/sendmessage', { msg: {...} })
      - 指数退避重试：最多 3 次，间隔 3s → 6s → 12s
   b. 成功 → debugLog('Sent successfully')
   c. 失败 → debugLog('Send failed')
7. process.exit(0)
```

**注意：** hook-handler 对 CLI 和 VSCode 模式都生效。CLI 模式下，bridge 的 PTY 输出缓冲不会直接发送到微信，微信推送完全依赖 hook-handler。

---

## 6. 进程管理设计

### 6.1 进程生命周期

| 模式 | 进程链 | 生命周期绑定 | 关闭方式 |
|------|--------|-------------|----------|
| CLI | CMD窗口B → launcher → bridge → pty claude | `--launcher-pid` 检测 | 关 CMD窗口B → 全链退出 |
| VSCode | bridge（detached 后台） | 无绑定 | `/unwechat` 或下次 `/wechat` 启动时清理 |

### 6.2 `--launcher-pid` 机制

```
启动时：
  launcher.js → spawn bridge.js --launcher-pid <launcher PID>

运行时：
  bridge.js 每 3s 执行 process.kill(launcherPid, 0)
  若 launcher 不存在 → shutdown() → 全链退出

触发场景：
  - 用户点击 CMD 窗口 X 关闭
  - 用户按 Ctrl+C
  - CMD 窗口被系统强制关闭
  - launcher 进程崩溃
```

### 6.3 killAllBridgeProcesses() 清理策略

不使用 wmic（新 Windows 可能不可用，且会误杀其他进程）。使用三层清理：

```
1. 按 PID 杀：读取 state.json → taskkill /PID /F /T（/T 杀进程树）
2. 按 PTY PID 杀：读取 pty.pid → taskkill /PID /F /T
3. 按端口杀：netstat -ano | findstr :3456 | findstr LISTENING → 解析 PID → killProcess
4. 清理文件：删除 state.json、bridge.pid
```

---

## 7. 数据流

### 7.1 微信消息 → Claude Code（CLI 模式）

```
微信用户发消息
  → iLink 服务器
    → [wechat.ts] getUpdates 长轮询（3s 间隔）
      → 解析 msg_list，去重，过滤系统/Bot 消息
        → formatForClaude()："[微信消息 14:30:05 from 张三]：你好"
          → [queue.ts] enqueue()（msgId 去重）
            → [pty-server.ts] processQueue()（每 1s）
              → 等待 claudeReady + !claudeBusy
                → dequeueAll() → 取最旧一条
                  → pty.write('\x1b[200~' + text + '\x1b[201~')
                    → 50ms 后 pty.write('\r')
                      → Claude Code 收到输入 → 开始处理
```

### 7.2 Claude Code 回复 → 微信

```
Claude Code 完成回复
  → Claude Code 触发 Stop hook
    → 执行: node hook-handler.js
      → stdin 接收 { last_assistant_message: "回复内容" }
        → [hook-handler.ts] 解析消息
          → [wechat.ts] sendMessage()
            → 速率限制（2500ms/用户）
              → POST /ilink/bot/sendmessage
                → 指数退避重试（3次）
                  → iLink 服务器 → 微信用户收到回复
```

### 7.3 VSCode 模式数据流

```
Claude Code（VSCode 中）完成回复
  → Stop hook → hook-handler.js → sendMessage() → 微信

（bridge 仅维持 getUpdates 轮询连接，使 iLink API 保持活跃）
```

---

## 8. 文件系统

### 8.1 目录结构

```
~/.wechat-claude-skill/          # Bridge 运行时数据目录
  ├── account.json               # 微信 Bot 账号（botToken, userId 等）
  ├── state.json                 # Bridge 运行状态（mode, pid, startedAt）
  ├── bridge.pid                 # Bridge 进程 PID
  ├── pty.pid                    # PTY（Claude Code）进程 PID
  ├── sync_buf.json              # 消息同步缓冲区（getUpdates 断点续传）
  ├── cli-launcher.js            # CLI 模式启动器脚本（临时生成）
  ├── bridge.log                 # Bridge 运行日志
  └── hook-handler.log           # Hook 执行日志

~/.claude/                       # Claude Code 全局配置目录
  ├── settings.json              # Hook 配置（Stop → hook-handler.js）
  └── skills/
      ├── wechat/SKILL.md        # /wechat 命令指令
      └── unwechat/SKILL.md      # /unwechat 命令指令
```

### 8.2 文件读写时序

| 时机 | 操作 | 文件 |
|------|------|------|
| install | 写 | settings.json, wechat/SKILL.md, unwechat/SKILL.md |
| cli/vscode 启动 | 读+写 | state.json, account.json, settings.json, pty.pid, bridge.pid |
| 扫码登录 | 写 | account.json |
| Bridge 运行 | 追加写 | bridge.log, hook-handler.log, sync_buf.json |
| Bridge 就绪 | 写 | bridge.pid, state.json |
| PTY 启动 | 写 | pty.pid |
| unwechat | 读+删 | state.json, bridge.pid, pty.pid, account.json, settings.json |
| uninstall | 读+删 | 同 unwechat + wechat/SKILL.md + unwechat/SKILL.md |

---

## 9. 源码结构

```
src/
├── auth.ts          # QR 扫码登录（iLink API）
├── bridge.ts        # Bridge 主入口（HTTP + 轮询 + PTY 管理）
├── config.ts        # 配置常量（端口、目录、默认值）
├── hook-handler.ts  # Stop Hook 处理器（Claude 回复 → 微信）
├── pty-server.ts    # PTY 伪终端服务器（node-pty + 消息注入）
├── queue.ts         # 消息队列（FIFO + msgId 去重 + requeue）
├── setup.ts         # 安装/卸载/模式切换/进程管理
└── wechat.ts        # iLink Bot API 客户端（发送/轮询/限流/重试）
```

---

## 10. 关键设计决策

### 10.1 为什么用 node-pty 而不是 child_process.spawn？

Claude Code 是交互式终端程序（TUI），需要：
1. **真实终端**：Claude Code 使用全屏渲染、光标定位、颜色等终端特性。spawn 创建的管道没有 TTY，Claude Code 无法正常显示
2. **实时注入**：spawn 只能在启动时传入 stdin，无法在运行中动态注入。node-pty 支持随时 write()
3. **Bracketed paste 兼容**：Claude Code 启用了 bracketed paste mode，必须用 \x1b[200~...\x1b[201~ 包裹

### 10.2 为什么用 --continue 而不是 --new？

用户用 /wechat 的目的是继续在微信中和同一个 Claude Code 对话，不是开新会话。--continue 恢复最近对话，微信消息在同一个上下文中处理。

### 10.3 为什么需要上下文重置消息？

--continue 恢复的对话上下文停留在 /wechat，Claude Code 会把后续输入理解为"继续执行 wechat skill"。注入重置消息告诉 Claude Code 微信绑定已完成，恢复正常对话模式。

### 10.4 为什么不用 wmic 杀进程？

1. Windows 新版本可能不预装 wmic
2. `wmic process where "CommandLine like '%bridge.js%'"` 会匹配所有包含 bridge.js 的命令行，可能误杀其他 Node.js 进程
3. 改用 netstat 端口检测 + PID 文件，更精确更安全

### 10.5 为什么 bridge 用 SIGKILL 自杀？

Windows 上 node-pty 创建的 ConPTY 子进程会阻止 `process.exit()` 正常退出。即使调用了 `process.exit(0)`，进程仍然挂起。`process.kill(process.pid, 'SIGKILL')` 在 1s 延迟后强制终止，确保 bridge 真正退出。

---

## 11. 已知问题与限制

| 问题 | 说明 | 影响 |
|------|------|------|
| Hook 全局生效 | settings.json 的 Stop hook 对所有 Claude Code 实例生效 | 多实例时回复都推微信 |
| 单实例限制 | Bridge 固定监听 3456 端口 | 不能同时跑多个 Bridge |
| 长消息截断 | 超过 4000 字符截断 | 长回复不完整 |
| 会话过期 | iLink Bot 长时间不活跃过期（errcode=-14） | 需重新扫码 |
| 微信消息仅支持文本 | 图片/文件只显示占位符 | 富媒体不支持 |
| VSCode 模式 bridge 残留 | 关 VSCode 后 bridge 继续后台运行 | 需 /unwechat 清理 |

---

## 12. 致谢

- [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) — 灵感来源和 iLink API 实现参考
- [node-pty](https://github.com/microsoft/node-pty) — Microsoft 维护的跨平台伪终端库
