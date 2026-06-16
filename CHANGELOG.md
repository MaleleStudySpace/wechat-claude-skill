# Changelog

## 2026-06-16 - 端到端测试通过

### 新增
- 全局 skill 配置（~/.claude/skills/wechat.md）
- Bridge HTTP 服务接收 Stop hook
- 微信消息轮询（getupdates）和队列管理
- sendmessage 保护逻辑（session 过期重试、限流退避）
- UTF-8 编码强制（middleware）

### 修复
- message_type 字段名（API 返回 message_type，不是 msg_type）
- sync_buf 更新逻辑（fetchMessages 返回新 sync_buf）
- UIN 每次请求重新生成（缓存会导致 ret=-2）
- console.log 在 detached 进程中丢失（改用 appendFileSync）

### 验证
- ✅ QR 扫码登录
- ✅ Claude → 微信（sendmessage）
- ✅ 微信 → Bridge 队列（getupdates）
- ✅ Hook 返回注入消息
- ✅ UTF-8 编码（中文正常显示）

## 2026-06-15 - 初始实现

### 新增
- 项目结构和 TypeScript 配置
- QR 扫码登录（auto-refresh 过期自动重新生成）
- iLink API 封装（sendmessage、getupdates）
- Bridge 服务器（Express HTTP）
- PTY 服务器（CLI 模式）
- Hook handler（VSCode 模式）
- 消息队列和去重
