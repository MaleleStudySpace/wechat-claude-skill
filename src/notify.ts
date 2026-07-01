/**
 * Windows toast notification for bridge disconnect alerts.
 *
 * Uses the WinRT Toast API (Windows.UI.Notifications) via PowerShell.
 * This is the same system that apps like Slack, Discord, etc. use —
 * notifications appear in the Windows Action Center, not as modal dialogs.
 *
 * No third-party modules required (no BurntToast needed).
 *
 * IMPORTANT: The PS script is written to a temp .ps1 file and executed via
 * `powershell -File` to avoid $variable mangling by cmd.exe when using -Command.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from 'node:child_process';

const TOAST_TITLE = '⚠️ Claude to WeChat 连接可能已断开';
const TOAST_BODY =
  'Claude 与微信的连接可能已失效。\n' +
  '· 在微信中主动回复一条消息可恢复会话\n' +
  '· 或执行 /unwechat 重新绑定';

// AppId for Windows toast — use PowerShell's registered AppId so the toast
// shows up in Action Center with a proper icon and doesn't require registration.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Show a Windows Action Center toast notification.
 * Non-blocking, fire-and-forget.
 *
 * Uses WinRT Toast XML template + Windows.UI.Notifications API.
 * This is the official way to show toasts on Windows 10/11.
 */
export function showDisconnectToast(): void {
  // Build the toast XML — use literal newlines in <text>, not &#10; entities
  // (WinRT Toast renders literal \n as line breaks; &#10; gets double-escaped by escapeXml)
  const toastXml = `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(TOAST_TITLE)}</text><text>${escapeXml(TOAST_BODY)}</text></binding></visual><audio silent="true"/></toast>`;

  // Write PS script to a temp .ps1 file (avoids cmd.exe $variable mangling)
  const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('${toastXml.replace(/'/g, "''")}')

$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}')
$notifier.Show($toast)
`.trim();

  const tmpPs1 = join(tmpdir(), `wechat-toast-${Date.now()}.ps1`);
  try {
    // Write UTF-8 BOM so PowerShell 5.x correctly reads CJK characters
    writeFileSync(tmpPs1, '﻿' + psScript, 'utf-8');
  } catch {
    return;
  }

  exec(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpPs1}"`,
    { timeout: 10_000, windowsHide: true },
    (err) => {
      // Clean up temp file
      try { unlinkSync(tmpPs1); } catch {}
      if (err) {
        // Fallback: Windows.Forms balloon tip (system tray notification)
        showBalloonFallback();
      }
    },
  );
}

/** Fallback: System tray balloon notification via Windows.Forms. */
function showBalloonFallback(): void {
  const title = TOAST_TITLE.replace(/'/g, "''");
  const body = TOAST_BODY.replace(/\n/g, ' ').replace(/'/g, "''");
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.Visible = $true
$n.ShowBalloonTip(10000, '${title}', '${body}', [System.Windows.Forms.ToolTipIcon]::Warning)
Start-Sleep -Seconds 11
$n.Dispose()
`.trim();

  // Also write to temp .ps1 to avoid $variable issues
  const tmpPs1 = join(tmpdir(), `wechat-balloon-${Date.now()}.ps1`);
  try {
    // Write UTF-8 BOM so PowerShell 5.x correctly reads CJK characters
    writeFileSync(tmpPs1, '﻿' + psScript, 'utf-8');
  } catch {
    return;
  }

  exec(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpPs1}"`,
    { timeout: 15_000, windowsHide: true },
    () => {
      try { unlinkSync(tmpPs1); } catch {}
    },
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
