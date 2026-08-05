const { spawn } = require('child_process')
const { screen } = require('electron')

let ps = null
let ready = false

const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint MOVE=0x0001, LD=0x0002, LU=0x0004, RD=0x0008, RU=0x0010, WH=0x0800;
  public const uint KEYUP=0x0002;
}
"@
[Console]::InputEncoding = [Text.UTF8Encoding]::UTF8
[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq '') { continue }
  try {
    $o = $line | ConvertFrom-Json
    if ($o.op -eq 'mouse') {
      if ($null -ne $o.x -and $null -ne $o.y) { [void][NativeInput]::SetCursorPos([int]$o.x, [int]$o.y) }
      $flags = 0
      if ($o.event -eq 'down') { $flags = if ([int]$o.button -eq 2) { [NativeInput]::RD } else { [NativeInput]::LD } }
      elseif ($o.event -eq 'up') { $flags = if ([int]$o.button -eq 2) { [NativeInput]::RU } else { [NativeInput]::LU } }
      elseif ($o.event -eq 'wheel') { $flags = [NativeInput]::WH; [NativeInput]::mouse_event($flags, 0, 0, [uint32](-[int]$o.deltaY), [UIntPtr]::Zero); continue }
      elseif ($o.event -eq 'move') { continue }
      if ($flags -ne 0) { [NativeInput]::mouse_event($flags, 0, 0, 0, [UIntPtr]::Zero) }
    } elseif ($o.op -eq 'key') {
      $vk = [byte]([int]$o.vk)
      if ($o.event -eq 'up') { [NativeInput]::keybd_event($vk, 0, [NativeInput]::KEYUP, [UIntPtr]::Zero) }
      else { [NativeInput]::keybd_event($vk, 0, 0, [UIntPtr]::Zero) }
    }
  } catch {}
}
`

function ensureWorker() {
  if (process.platform !== 'win32') return false
  if (ps && !ps.killed) return true
  ready = false
  ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  ps.on('exit', () => { ps = null; ready = false })
  ready = true
  return true
}

function send(obj) {
  if (!ensureWorker() || !ps?.stdin?.writable) return
  try { ps.stdin.write(`${JSON.stringify(obj)}\n`) } catch {}
}

function resolveXY(x, y) {
  const disp = screen.getPrimaryDisplay()
  const scale = Number(disp.scaleFactor) > 0 ? Number(disp.scaleFactor) : 1
  // Electron size 为逻辑像素；Win32 SetCursorPos 需要物理像素
  const width = Math.max(1, Math.round((disp.size?.width || 1) * scale))
  const height = Math.max(1, Math.round((disp.size?.height || 1) * scale))
  const xf = Number(x)
  const yf = Number(y)
  if (xf >= 0 && xf <= 1.0001 && yf >= 0 && yf <= 1.0001) {
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(xf * (width - 1)))),
      y: Math.max(0, Math.min(height - 1, Math.round(yf * (height - 1)))),
    }
  }
  // 已是绝对像素，不再二次缩放
  return { x: Math.round(xf), y: Math.round(yf) }
}

const KEY_MAP = {
  Enter: 0x0d, Escape: 0x1b, Backspace: 0x08, Tab: 0x09, Space: 0x20, Delete: 0x2e,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
}

function vkFromKey(key, code) {
  if (KEY_MAP[code]) return KEY_MAP[code]
  if (KEY_MAP[key]) return KEY_MAP[key]
  if (key && key.length === 1) {
    const ch = key.toUpperCase()
    const codePoint = ch.charCodeAt(0)
    if (codePoint >= 65 && codePoint <= 90) return codePoint
    if (codePoint >= 48 && codePoint <= 57) return codePoint
  }
  return 0
}

function handleControlPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  const typ = String(payload.type || payload.action || '')
  if (typ === 'mouse') {
    const pt = resolveXY(payload.x, payload.y)
    send({
      op: 'mouse',
      event: String(payload.event || payload.action || 'move'),
      button: Number(payload.button || 0),
      deltaY: Number(payload.deltaY || 0),
      x: pt.x,
      y: pt.y,
    })
    return true
  } else if (typ === 'key' || typ === 'keyboard') {
    const vk = Number(payload.vk) || vkFromKey(String(payload.key || ''), String(payload.code || ''))
    if (!vk) return false
    send({ op: 'key', event: String(payload.event || payload.action || 'down'), vk })
    return true
  }
  return false
}

function stopWorker() {
  try { ps?.stdin?.end() } catch {}
  try { ps?.kill() } catch {}
  ps = null
  ready = false
}

module.exports = { handleControlPayload, stopWorker, ensureWorker }
