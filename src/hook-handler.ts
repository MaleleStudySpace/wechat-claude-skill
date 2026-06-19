/**
 * Stop hook handler.
 *
 * Triggered by Claude Code's Stop event (fires when Claude finishes responding).
 * Reads `last_assistant_message` from stdin and sends it to WeChat.
 *
 * Works for both VSCode and CLI modes:
 * - VSCode: one-way notification (Claude → WeChat)
 * - CLI: one-way notification here; bridge handles WeChat → Claude via PTY
 *
 * Exit 0: normal exit, Claude stays stopped (ready for next user input)
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccount } from './auth.js';
import { sendMessage } from './wechat.js';
import type { BridgeConfig } from './config.js';

const LOG_FILE = join(homedir(), '.wechat-claude-skill', 'hook-handler.log');
const MAX_MESSAGE_LENGTH = 4000;

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

async function main(): Promise<void> {
  // Log immediately — proves the hook was triggered
  debugLog('=== Hook triggered ===');

  // Read hook input from stdin
  const inputStr = await readStdin();
  debugLog(`stdin length: ${inputStr.length}`);

  let hookInput: any = {};
  try { hookInput = JSON.parse(inputStr); } catch {
    debugLog('Failed to parse stdin as JSON, continuing');
  }

  // Use last_assistant_message from hook input (provided by Claude Code)
  const message: string | undefined = hookInput.last_assistant_message;
  if (!message || !message.trim()) {
    debugLog('No assistant message in hook input, exiting');
    process.exit(0);
  }

  debugLog(`Message length: ${message.length}`);

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

  // Truncate if too long
  const text = message.length > MAX_MESSAGE_LENGTH
    ? message.slice(0, MAX_MESSAGE_LENGTH) + '\n\n... (消息过长，已截断)'
    : message;

  // Send to WeChat
  debugLog('Sending to WeChat...');
  const result = await sendMessage(config, account.userId, text);

  if (result.success) {
    debugLog(`Sent successfully (msgId: ${result.msgId || 'unknown'})`);
  } else {
    debugLog(`Send failed: ${result.error}`);
  }

  process.exit(0);
}

main();
