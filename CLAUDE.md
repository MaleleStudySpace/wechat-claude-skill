# wechat-claude-skill 项目规则

## 每次修改必须提交 Git

每次对代码的修改完成后，必须执行 `git add` 和 `git commit`。

### Commit Message 规范（必须严格遵守）

commit message 必须是一份**完整的变更总结**，让任何开发者读完就能理解改了什么、为什么改、怎么改的、改后效果。**禁止一行概要。**

格式：

    <type>: <简短标题>

    === 问题/需求 ===
    <问题根因或需求背景>

    === 方案 ===
    <实现要点，按改动区域分段>

    文件: file1.py(改了什么), file2.jsx(改了什么)

    === 效果 ===
    <改后的行为/体验变化>

type 枚举: `feat`(新功能), `fix`(修bug), `refactor`(重构), `docs`(文档), `style`(样式)

示例:

    fix: 定时群摘要不触发 -- 调度器配置热更新

    === 问题 ===
    PUT /api/assistant/config 只写磁盘, DigestScheduler 持有旧 config 引用,
    用户改了时间必须重启 bot 才能生效

    === 方案 ===
    scheduler.py 新增 update_config() 方法, 替换 self._config;
    server.py PUT handler 保存后调用 _assistant_scheduler.update_config();
    bot.py 启动/停止时注册/注销调度器引用

    文件: scheduler.py(update_config), server.py(注册+热更新调用),
          bot.py(register_assistant_scheduler 注册/注销)

    === 效果 ===
    配置保存后调度器立即生效, 无需重启 bot

### 自查清单

每次 commit 前自问:

1. 读完这条 message, 能理解改动的全貌吗?
2. 3 个月后翻 git log, 能靠这条 message 判断要不要 revert 吗?
3. 如果不能, 补充细节直到能。
