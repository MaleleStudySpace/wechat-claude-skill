/**
 * Setup script for wechat-claude-skill.
 *
 * Called by the /wechat or /unwechat skill.
 *
 * Usage:
 *   node setup.js cli [sessionId]   - CLI mode: QR login + start bridge + PTY
 *   node setup.js vscode            - VSCode mode: QR login + start bridge + hooks
 *   node setup.js unbind            - Stop bridge + clean up
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { loadAccount, interactiveLogin, type AccountData } from './auth.js';
import { BRIDGE_DIR } from './config.js';

const BRIDGE_PID_FILE = join(BRIDGE_DIR, 'bridge.pid');
const STATE_FILE = join(BRIDGE_DIR, 'state.json');
const HOOK_HANDLER_PATH = join(import.meta.dirname, 'hook-handler.js');

interface State {
  mode: 'cli' | 'vscode';
  pid: number;
  startedAt: string;
  sessionId?: string;
  cwd?: string;
}

function saveState(state: State): void {
  mkdirSync(BRIDGE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function loadState(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function isBridgeRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopExistingBridge(): void {
  const state = loadState();
  if (state && isBridgeRunning(state.pid)) {
    console.log(`Stopping existing bridge (PID ${state.pid})...`);
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!isBridgeRunning(state.pid)) break;
    }
  }
  try { unlinkSync(BRIDGE_PID_FILE); } catch {}
  try { unlinkSync(STATE_FILE); } catch {}
}

/**
 * Ensure we have a valid account. Do QR login if needed.
 */
async function ensureAccount(): Promise<AccountData> {
  let account = loadAccount();
  if (account) {
    console.log(`Using existing account: ${account.accountId}`);
    return account;
  }

  console.log('No account found. Starting QR code login...\n');
  account = await interactiveLogin();
  console.log(`\nLogin successful! Account: ${account.accountId}`);
  return account;
}

function getClaudeSettingsPath(): string {
  // Always use project-level: {cwd}/.claude/settings.json
  return join(process.cwd(), '.claude', 'settings.json');
}

function writeHookConfig(): void {
  const settingsPath = getClaudeSettingsPath();
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {}
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = [{
    hooks: [{
      type: 'command',
      command: `node ${HOOK_HANDLER_PATH}`,
      asyncRewake: true,
      timeout: 3600,
    }],
  }];

  const dir = join(settingsPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Hook config written to: ${settingsPath}`);
}

function removeHookConfig(): void {
  const settingsPath = getClaudeSettingsPath();
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (settings.hooks?.Stop) {
      delete settings.hooks.Stop;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`Hook config removed from: ${settingsPath}`);
  } catch {}
}

function startBridge(mode: 'cli' | 'vscode', sessionId?: string): void {
  const bridgePath = join(import.meta.dirname, 'bridge.js');
  const args = [bridgePath, '--mode', mode];
  if (sessionId) args.push('--session', sessionId);
  args.push('--cwd', process.cwd());

  const child = spawn('node', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.unref();

  let output = '';
  child.stdout?.on('data', (data) => {
    output += data.toString();
    const match = output.match(/BRIDGE_READY:(\d+)/);
    if (match) {
      const pid = parseInt(match[1], 10);
      saveState({ mode, pid, startedAt: new Date().toISOString(), sessionId, cwd: process.cwd() });
      console.log(`Bridge started (PID ${pid})`);
    }
  });

  child.stderr?.on('data', (data) => {
    console.error(`Bridge error: ${data.toString()}`);
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Bridge exited with code ${code}`);
    }
  });
}

// --- CLI mode ---
async function setupCli(): Promise<void> {
  console.log('Setting up WeChat binding (CLI mode)...\n');

  stopExistingBridge();
  await ensureAccount();

  const sessionId = process.argv[3];
  startBridge('cli', sessionId);
  writeHookConfig();

  console.log('\n✅ 微信绑定已启动 (CLI 模式)');
  console.log('   微信消息将作为用户输入注入（100% 可靠）');
  console.log('\n⚠️  当前 Claude Code 会话即将退出，bridge 将启动新会话...');
}

// --- VSCode mode ---
async function setupVscode(): Promise<void> {
  console.log('Setting up WeChat binding (VSCode mode)...\n');

  stopExistingBridge();
  await ensureAccount();

  startBridge('vscode');
  writeHookConfig();

  console.log('\n✅ 微信绑定已启动 (VSCode 模式)');
  console.log('   ⚠️  微信回复将作为系统提醒注入，大概率会被处理');
  console.log('   如需 100% 可靠，请使用 CLI 终端模式');
}

// --- Unbind ---
function unbind(): void {
  console.log('Unbinding WeChat...');
  stopExistingBridge();
  removeHookConfig();
  console.log('✅ 微信已解绑');
}

// --- Main ---
const action = process.argv[2];
switch (action) {
  case 'cli':
    setupCli().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
    break;
  case 'vscode':
    setupVscode().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
    break;
  case 'unbind':
    unbind();
    break;
  default:
    console.error('Usage: node setup.js [cli|vscode|unbind]');
    process.exit(1);
}
