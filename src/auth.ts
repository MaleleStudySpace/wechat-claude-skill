/**
 * WeChat iLink QR code login.
 *
 * Reuses the same iLink API as wechat-claude-code.
 * Saves account data to ~/.wechat-claude-skill/account.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const BRIDGE_DIR = join(homedir(), '.wechat-claude-skill');
const ACCOUNT_PATH = join(BRIDGE_DIR, 'account.json');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_CODE_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
const QR_STATUS_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status`;
const POLL_INTERVAL_MS = 1_000;

export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
}

interface QrCodeResponse {
  ret: number;
  qrcode?: string;
  qrcode_img_content?: string;
}

interface QrStatusResponse {
  ret: number;
  status: string;
  retmsg?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Save account data to disk. */
export function saveAccount(data: AccountData): void {
  mkdirSync(BRIDGE_DIR, { recursive: true });
  writeFileSync(ACCOUNT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Load saved account data. Returns null if not found. */
export function loadAccount(): AccountData | null {
  if (!existsSync(ACCOUNT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ACCOUNT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/** Phase 1: Request a QR code for login. Returns the URL and ID. */
export async function startQrLogin(): Promise<{ qrcodeUrl: string; qrcodeId: string }> {
  const res = await fetch(QR_CODE_URL);
  if (!res.ok) {
    throw new Error(`Failed to get QR code: HTTP ${res.status}`);
  }

  const data = (await res.json()) as QrCodeResponse;

  if (data.ret !== 0 || !data.qrcode_img_content || !data.qrcode) {
    throw new Error(`Failed to get QR code (ret=${data.ret})`);
  }

  return {
    qrcodeUrl: data.qrcode_img_content,
    qrcodeId: data.qrcode,
  };
}

/**
 * Phase 2: Wait for the user to scan and confirm the QR code.
 * Throws on expiry so the caller can regenerate.
 * Returns the full AccountData on success.
 */
export async function waitForQrScan(qrcodeId: string): Promise<AccountData> {
  let lastStatus = '';
  let pollCount = 0;
  while (true) {
    const url = `${QR_STATUS_URL}?qrcode=${encodeURIComponent(qrcodeId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
        continue; // retry
      }
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Failed to check QR status: HTTP ${res.status}`);
    }

    const data = (await res.json()) as QrStatusResponse;

    switch (data.status) {
      case 'wait': {
        if (lastStatus !== 'wait') {
          console.log('⏳ 等待扫码...');
          lastStatus = 'wait';
        }
        break;
      }
      case 'scaned': {
        if (lastStatus !== 'scaned') {
          console.log('📱 已扫描！请在手机上点击确认...');
          lastStatus = 'scaned';
        }
        break;
      }

      case 'confirmed': {
        if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) {
          throw new Error('QR confirmed but missing required fields');
        }

        const accountData: AccountData = {
          botToken: data.bot_token,
          accountId: data.ilink_bot_id,
          baseUrl: data.baseurl || DEFAULT_BASE_URL,
          userId: data.ilink_user_id,
          createdAt: new Date().toISOString(),
        };

        saveAccount(accountData);
        return accountData;
      }

      case 'expired':
        throw new Error('QR code expired');

      default: {
        const status = data.status ?? '';
        if (status.includes('not_support') || status.includes('forbid') || status.includes('reject')) {
          throw new Error(`二维码扫描失败: ${data.retmsg || status}`);
        }
        // Unknown status — show it to the user
        if (status && status !== lastStatus) {
          console.log(`⚠️ 未知扫码状态: ${status} ${data.retmsg || ''}`);
          lastStatus = status;
        }
        break;
      }
    }

    pollCount++;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Interactive QR login: display QR code in terminal, wait for scan.
 * Auto-regenerates QR when expired.
 * Auto-opens QR code image in browser for easy scanning.
 * Returns AccountData on success.
 *
 * IMPORTANT: The QR code URL (qrcode_img_content) is a link like
 * https://liteapp.weixin.qq.com/q/... which shows a QR image in the browser.
 * WeChat scans this image. If the browser fails to load (network error),
 * the user can still scan the terminal ASCII QR code.
 */
export async function interactiveLogin(): Promise<AccountData> {
  let attempt = 0;
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    attempt++;

    console.log(`\n请用微信扫描二维码绑定 Bot${attempt > 1 ? '（已刷新）' : ''}：\n`);

    // Show terminal ASCII QR code (encodes the URL for reference)
    try {
      const qrcodeTerminal = await import('qrcode-terminal');
      console.log('终端二维码（备用）：');
      qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
      console.log();
    } catch {
      console.log(`二维码链接：${qrcodeUrl}\n`);
    }

    // Open QR image in browser — this is the primary scanning method.
    // The browser page renders the actual Bot binding QR image that WeChat can scan.
    // IMPORTANT: Must quote the URL because cmd treats & as command separator,
    // which truncates the URL at & (e.g. &bot_type=3 gets lost)
    try {
      const opener = process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', `"${qrcodeUrl}"`], { detached: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [qrcodeUrl], { detached: true, stdio: 'ignore' });
      opener.unref();
      console.log(`📱 已在浏览器中打开二维码${attempt > 1 ? '（已刷新）' : ''}，请用微信扫描浏览器中的二维码`);
    } catch {
      console.log(`📱 请手动复制链接到浏览器打开：${qrcodeUrl}`);
    }

    console.log('\n等待扫码（二维码过期自动刷新，按 Ctrl+C 取消）...');

    try {
      const account = await waitForQrScan(qrcodeId);
      return account;
    } catch (e: any) {
      if (e.message?.includes('expired')) {
        console.log('\n二维码已过期，正在重新生成...\n');
        continue;
      }
      throw e;
    }
  }
}
