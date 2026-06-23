# wechat-claude-skill

在微信上和 Claude 聊天，回复自动同步到电脑——不用切窗口，不用复制粘贴。

## 这是什么？

你平时用 Claude Code 写代码、问问题，只能坐在电脑前。装了这个工具之后：

- 你在**微信**给 Bot 发消息，Claude 自动收到并回复
- Claude 的回复**自动推送到微信**，手机上就能看到
- 电脑终端也能继续正常输入，**两边都能用**

简单说：**把 Claude 装进了你的微信**。

## 30 秒上手

```bash
# 1. 安装（需要 Node.js 18+）
npm install -g wechat-claude-skill

# 2. 打开终端，启动 Claude Code
claude

# 3. 在 Claude Code 里输入
/wechat
```

选择「CLI 终端」，扫码绑定微信，然后在微信里给 Bot 发条消息——搞定。

之后你在微信发消息就是跟 Claude 聊天，Claude 的回复直接出现在微信里。

> 💡 安装时 `postinstall` 会自动配置 Skill 和 Hook。如果自动配置失败（如 npx 临时缓存），可手动执行 `wechat-claude-skill install`。

## 使用方式

### 方式一：终端 + 微信（推荐）

在电脑终端里用 Claude，同时微信也能发消息给 Claude，两边都能收到回复。

1. 打开终端，运行 `claude`
2. 输入 `/wechat`，选择「CLI 终端」
3. 扫码绑定微信
4. 自动弹出一个新终端窗口（标题栏有「微信桥接」标识）
5. 旧窗口可以关掉，在新窗口继续使用
6. 在微信中给 Bot 发一条消息激活（首次必须）

> 💡 新窗口里你可以正常打字跟 Claude 对话，也可以在微信里发消息，Claude 两边都响应。

### 方式二：VSCode + 微信

在 VSCode 中使用 Claude Code，Claude 的回复自动推送到微信。

1. 在 VSCode 的 Claude Code 中输入 `/wechat`
2. 选择「VSCode」
3. 扫码绑定，然后在微信中给 Bot 发一条消息激活
4. 之后 Claude 的回复自动出现在微信里

> ⚠️ VSCode 模式是**单向推送**：Claude 回复会推送到微信，但你在微信发消息 Claude 不会收到（因为没有终端来注入消息）。

### 解绑

在 Claude Code 中输入 `/unwechat`，或运行 `wechat-claude-skill unbind`。

---

## 架构

### CLI 模式（终端 + 微信，双向）

```
  微信客户端 ◄──── iLink API ────► Bridge 进程
                                    │
                                    ├─ getUpdates 轮询
                                    │  → 收到微信消息 → 消息队列
                                    │
                                    ├─ PTYServer (node-pty)
                                    │  → 运行 claude --continue
                                    │  → 将微信消息注入 Claude 输入
                                    │
                                    └─ Stop Hook (hook-handler)
                                       → Claude 回复完成 → 推送到微信

  新终端窗口 ◄── stdin/stdout ──► PTYServer
  （用户手动输入 / 查看回复）
```

**数据流**：微信发消息 → Bridge 轮询收到 → 注入 Claude Code → Claude 回复 → Hook 触发 → 推送回微信

### VSCode 模式（VSCode + 微信，单向）

```
  微信客户端 ◄── sendMessage ─── hook-handler
                                    ▲
                                    │ Claude 回复完成时触发
                              VSCode Claude Code
                              （用户正常使用）
```

**数据流**：VSCode 中 Claude 回复 → Hook 触发 → 推送到微信。Bridge 仅维持 Bot 在线。

## 为什么用 node-pty 而不是 child_process.spawn？

Claude Code 是一个交互式终端程序（TUI），它需要：

1. **真实终端**：Claude Code 使用全屏渲染、光标定位、颜色等终端特性。`spawn` 创建的管道没有 TTY，Claude Code 无法正常显示
2. **实时注入**：`spawn` 只能在启动时传入 stdin，无法在运行过程中动态注入新消息。`node-pty` 支持随时 `write()`，实现微信消息的实时注入
3. **粘贴模式兼容**：Claude Code 启用了 bracketed paste mode，直接写入文本不会触发提交。必须用 `\x1b[200~...\x1b[201~` 包裹后再发送 Enter

## 项目结构

```
src/
├── auth.ts          # QR 扫码登录
├── bridge.ts        # Bridge 主入口（HTTP + 轮询 + PTY）
├── config.ts        # 配置常量
├── hook-handler.ts  # Claude 回复 → 推送微信
├── pty-server.ts    # 伪终端服务器（node-pty + Claude Code）
├── queue.ts         # 消息队列（去重 + FIFO）
├── setup.ts         # 安装/卸载/模式切换
└── wechat.ts        # iLink Bot API（发送/轮询/限流）
```

## 已知问题

| 问题 | 说明 |
|------|------|
| Hook 全局生效 | 所有 Claude Code 实例的回复都会推送到微信，无法区分来源 |
| 仅支持单实例 | 同一时间只能运行一个 Bridge（CLI 或 VSCode），端口 3456 固定 |
| 长消息截断 | 超过 4000 字符的回复会被截断 |
| 会话过期 | Bot 长时间不活跃会过期，需重新扫码 |
| VSCode bridge 残留 | 关掉 VSCode 后 bridge 仍在后台运行，需 `/unwechat` 清理 |
| 微信仅支持文本 | 图片/文件消息只显示占位符 |

## 致谢

- [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) — 灵感来源和 iLink API 实现参考
- [node-pty](https://github.com/microsoft/node-pty) — Microsoft 维护的跨平台伪终端库

## License

MIT
