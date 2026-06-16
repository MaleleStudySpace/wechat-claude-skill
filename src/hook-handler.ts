/**
 * Stop hook handler script.
 *
 * This script is called by Claude Code's Stop hook (asyncRewake).
 * It reads the hook input (stdin), extracts the assistant's response
 * from the transcript, sends it to the bridge, and checks the queue.
 *
 * For CLI mode: bridge handles injection via PTY, this just forwards.
 * For VSCode mode: returns WeChat message as stderr + exit 2.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const BRIDGE_URL = 'http://localhost:3456';

async function readStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('\n');
}

function extractLastAssistantMessage(transcriptPath: string): string {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Walk backwards to find the last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role === 'assistant' && entry.content) {
          // content can be string or array of content blocks
          if (typeof entry.content === 'string') {
            return entry.content;
          }
          if (Array.isArray(entry.content)) {
            const textBlocks = entry.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text);
            return textBlocks.join('\n');
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  } catch {
    // transcript not readable
  }
  return '';
}

async function main() {
  // 1. Read hook input from stdin
  const inputStr = await readStdin();
  let hookInput: any = {};
  try {
    hookInput = JSON.parse(inputStr);
  } catch {
    // stdin might be empty or non-JSON
  }

  const transcriptPath = hookInput.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  // 2. Extract last assistant message
  const message = extractLastAssistantMessage(transcriptPath);
  if (!message) {
    process.exit(0);
  }

  // 3. POST to bridge
  try {
    const resp = await fetch(`${BRIDGE_URL}/hooks/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: hookInput.session_id,
        message,
        cwd: hookInput.cwd,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await resp.json() as any;

    // 4. Check if there's a WeChat message to inject (VSCode mode)
    if (data.mode === 'vscode' && data.inject) {
      // Output WeChat message as stderr → Claude gets it as system reminder
      process.stderr.write(`【微信消息 from ${data.from}】：${data.inject}`);
      process.exit(2); // Wake Claude
    }

    // CLI mode: bridge handles injection via PTY, just exit normally
    process.exit(0);
  } catch {
    // Bridge not running or error
    process.exit(0);
  }
}

main();
