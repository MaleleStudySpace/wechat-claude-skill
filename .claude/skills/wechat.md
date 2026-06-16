---
name: wechat
description: Bind current Claude Code session to WeChat for message sync
---

When the user runs `/wechat`, do the following:

1. Ask the user to select their environment:
   - "1. CLI 终端"
   - "2. VSCode"

2. Based on their choice, run the appropriate command:

   **For CLI terminal:**
   ```bash
   node c:/Users/1/Desktop/开源项目/wechat-claude-skill/dist/setup.js cli ${CLAUDE_SESSION_ID}
   ```

   **For VSCode:**
   ```bash
   node c:/Users/1/Desktop/开源项目/wechat-claude-skill/dist/setup.js vscode
   ```

3. After running the command:
   - For CLI: Tell the user "正在启动微信绑定，Claude Code 将自动重启..." then EXIT this session (use the Bash tool to run `exit` or similar)
   - For VSCode: Tell the user the binding is complete and show the warning about WeChat reply reliability

IMPORTANT: After running the CLI setup command, you MUST exit the current Claude Code session. The bridge will start a new session with the full conversation history preserved.
