/**
 * PTY server for CLI mode.
 *
 * Creates a pseudo-terminal, spawns Claude Code inside it,
 * and multiplexes user input + WeChat messages into Claude's stdin.
 *
 * When running as a detached process (bridge), stdout/stdin are piped.
 * We detect this and open the terminal device directly (/dev/tty or CONOUT$).
 */

import * as pty from 'node-pty';
import { writeFileSync, existsSync, mkdirSync, appendFileSync, createWriteStream, createReadStream, unlinkSync } from 'node:fs';
import type { WriteStream, ReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BridgeConfig } from './config.js';
import type { MessageQueue } from './queue.js';

const BRIDGE_DIR = join(homedir(), '.wechat-claude-skill');
const PTY_PID_FILE = join(BRIDGE_DIR, 'pty.pid');
const LOG_FILE = join(BRIDGE_DIR, 'bridge.log');

export interface PTYServerOptions {
  sessionId: string;
  cwd: string;
  config: BridgeConfig;
  queue: MessageQueue;
  onResponse: (output: string) => void;
  onError?: (error: Error) => void;
}

interface TerminalStreams {
  input: ReadStream | NodeJS.ReadStream;
  output: WriteStream | NodeJS.WriteStream;
}

/**
 * Open the terminal device directly.
 * Returns {input, output} streams connected to the terminal.
 * Falls back to process.stdin/stdout if already a TTY.
 */
function openTerminal(): TerminalStreams {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    return { input: process.stdin, output: process.stdout };
  }

  // Detached process: open terminal device directly
  const ttyPath = process.platform === 'win32' ? 'CONOUT$' : '/dev/tty';
  const ttyInPath = process.platform === 'win32' ? 'CONIN$' : '/dev/tty';

  try {
    const output = createWriteStream(ttyPath);
    const input = createReadStream(ttyInPath);
    return { input, output };
  } catch (e: any) {
    console.error(`[PTY] Failed to open terminal device: ${e.message}`);
    console.error('[PTY] Falling back to process.stdout/stdin');
    return { input: process.stdin, output: process.stdout };
  }
}

export class PTYServer {
  private ptyProcess: pty.IPty | null = null;
  private outputBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private terminal: TerminalStreams;

  constructor(private options: PTYServerOptions) {
    this.terminal = openTerminal();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const args = ['--resume', this.options.sessionId];
    this.log(`Starting: claude ${args.join(' ')}`);
    this.log(`Working directory: ${this.options.cwd}`);

    // Get terminal dimensions
    const cols = (this.terminal.output as NodeJS.WriteStream).columns || 120;
    const rows = (this.terminal.output as NodeJS.WriteStream).rows || 30;

    // On Windows, use claude.cmd (node-pty can't run POSIX shell scripts directly)
    const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    this.ptyProcess = pty.spawn(claudeCmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.options.cwd,
      env: process.env as Record<string, string>,
    });

    // Save PTY PID
    mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(PTY_PID_FILE, String(this.ptyProcess.pid), 'utf-8');

    // Forward PTY output to user terminal + buffer for WeChat
    this.ptyProcess.onData((data) => {
      // Write directly to terminal device
      this.terminal.output.write(data);
      // Buffer for WeChat forwarding
      this.bufferOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.log(`Claude Code exited with code ${exitCode}`);
      this.stop();
      process.exit(exitCode ?? 0);
    });

    // Forward user terminal input to PTY
    this.terminal.input.resume();
    if ('setRawMode' in this.terminal.input && typeof this.terminal.input.setRawMode === 'function') {
      this.terminal.input.setRawMode(true);
    }
    this.terminal.input.on('data', (data: Buffer | string) => {
      if (this.ptyProcess) {
        this.ptyProcess.write(data.toString());
      }
    });

    // Handle terminal resize (only works with real TTY)
    const stdout = this.terminal.output as NodeJS.WriteStream;
    if (typeof stdout.on === 'function' && stdout.isTTY) {
      stdout.on('resize', () => {
        if (this.ptyProcess) {
          this.ptyProcess.resize(
            stdout.columns || 120,
            stdout.rows || 30,
          );
        }
      });
    }

    // Start queue processor (inject WeChat messages into PTY)
    this.queueTimer = setInterval(() => this.processQueue(), 1000);

    this.log('Ready. User input and WeChat messages are multiplexed.');
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch {}
      this.ptyProcess = null;
    }
    // Clean up PID file
    try { unlinkSync(PTY_PID_FILE); } catch {}
  }

  private bufferOutput(data: string): void {
    this.outputBuffer += data;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushOutput(), 500);
  }

  private flushOutput(): void {
    if (!this.outputBuffer) return;
    this.options.onResponse(this.outputBuffer);
    this.outputBuffer = '';
  }

  private processQueue(): void {
    if (!this.running || !this.ptyProcess || this.options.queue.isEmpty) return;
    const item = this.options.queue.dequeue();
    if (!item) return;

    this.log(`Injecting WeChat message from ${item.from}: ${item.text}`);
    // Write to PTY stdin as if user typed it
    this.ptyProcess.write(item.text + '\n');
  }

  private log(msg: string): void {
    const now = new Date();
    const ts = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const line = `[${ts}] [PTY] ${msg}\n`;
    try {
      appendFileSync(LOG_FILE, line, 'utf-8');
    } catch {}
    // Also write to terminal if available
    if (this.terminal) {
      this.terminal.output.write(`[PTY] ${msg}\n`);
    }
  }
}
