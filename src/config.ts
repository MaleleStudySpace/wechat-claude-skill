/**
 * Configuration for wechat-claude-skill.
 *
 * Account data comes from auth.ts (QR code login).
 * Runtime settings are minimal defaults.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BridgeConfig {
  /** iLink bot token (from QR login) */
  botToken: string;
  /** WeChat account ID */
  accountId: string;
  /** WeChat user ID to send messages to (the person who scanned) */
  toUserId: string;
  /** iLink base URL */
  baseUrl: string;
  /** Bridge HTTP server port */
  port: number;
  /** WeChat polling interval in ms */
  pollInterval: number;
}

export const BRIDGE_DIR = join(homedir(), '.wechat-claude-skill');

export const DEFAULTS = {
  port: 3456,
  pollInterval: 3000,
};
