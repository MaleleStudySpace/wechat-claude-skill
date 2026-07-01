/**
 * Hook handler for multiple Claude Code hook events.
 *
 * Handles:
 * - Stop: Claude finished responding (last_assistant_message)
 * - Notification: system notifications
 * - StopFailure: API error occurred (error message)
 * - PostToolUseFailure: tool execution failed (tool name + error)
 * - PermissionRequest: permission dialog needs user action (permission description)
 * - Elicitation: MCP asking user for input (question)
 *
 * Exit 0: normal exit
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccount } from './auth.js';
import { sendMessage } from './wechat.js';
import { splitMessage } from './split-message.js';
import type { BridgeConfig } from './config.js';

const LOG_FILE = join(homedir(), '.wechat-claude-skill', 'hook-handler.log');

function debugLog(msg: string): void {
  const now = new Date();
  const beijingTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  try { appendFileSync(LOG_FILE, `[${beijingTime}] ${msg}\n`); } catch {}
}

async function readStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('\n');
}

/** Extract message content from different hook events */
function extractMessageFromHook(hookInput: any): string | undefined {
  // Stop: Claude finished responding
  if (hookInput.last_assistant_message) {
    return hookInput.last_assistant_message;
  }

  // StopFailure: API error occurred
  if (hookInput.error) {
    return `⚠️ Claude 发生错误:\n${hookInput.error}`;
  }

  // PostToolUseFailure: tool execution failed
  if (hookInput.tool_name && hookInput.tool_error) {
    return `⚠️ 工具执行失败:\n工具: ${hookInput.tool_name}\n错误: ${hookInput.tool_error}`;
  }

  // PermissionRequest: permission dialog
  if (hookInput.permission_type || hookInput.permission_description) {
    return `🔐 需要授权:\n${hookInput.permission_type || '权限请求'}\n${hookInput.permission_description || ''}`;
  }

  // Elicitation: MCP asking user for input
  if (hookInput.elicitation_question || hookInput.message) {
    return `❓ ${hookInput.elicitation_question || hookInput.message}`;
  }

  // Notification: system notification
  if (hookInput.message || hookInput.notification) {
    return hookInput.message || hookInput.notification;
  }

  // Fallback: try to stringify the whole input
  const str = JSON.stringify(hookInput);
  return str.length < 100 ? str : undefined;
}

async function main(): Promise<void> {
  debugLog('=== Hook triggered ===');

  const inputStr = await readStdin();
  debugLog(`stdin length: ${inputStr.length}`);

  let hookInput: any = {};
  try { hookInput = JSON.parse(inputStr); } catch {
    debugLog('Failed to parse stdin as JSON, exiting');
    process.exit(0);
  }

  // Determine which hook triggered this
  const hookType = hookInput.hook_input_type || hookInput.event_name || 'unknown';
  debugLog(`Hook type: ${hookType}`);

  // Extract message based on hook type
  const message = extractMessageFromHook(hookInput);
  if (!message || !message.trim()) {
    debugLog(`No message to send for hook type: ${hookType}, input: ${inputStr.slice(0, 200)}`);
    process.exit(0);
  }

  debugLog(`Extracted message (${message.length} chars): ${message.slice(0, 80)}...`);

  // Load account
  const account = loadAccount();
  if (!account) {
    debugLog('No account found, exiting');
    process.exit(0);
  }

  const config: BridgeConfig = {
    botToken: account.botToken,
    accountId: account.accountId,
    toUserId: account.userId,
    baseUrl: account.baseUrl,
    port: 3456,
    pollInterval: 3000,
  };

  // Split long messages into chunks
  const chunks = splitMessage(message);
  debugLog(`Message split into ${chunks.length} chunks`);

  // Send each chunk
  for (let i = 0; i < chunks.length; i++) {
    debugLog(`Sending chunk ${i + 1}/${chunks.length}...`);
    const result = await sendMessage(config, account.userId, chunks[i]);
    debugLog(`Chunk ${i + 1} result: ${result.success ? 'OK' : 'FAIL: ' + result.error}`);
  }

  process.exit(0);
}

main();