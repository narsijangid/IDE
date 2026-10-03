# Resident helper for OLKIL Remote. Captures one editor window and applies
# pointer and key input inside that window only. Speaks line protocol on stdin/stdout.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class OlkilWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, int extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public const uint LEFTDOWN = 0x02;
  public const uint LEFTUP = 0x04;
  public const uint RIGHTDOWN = 0x08;
  public const uint RIGHTUP = 0x10;
  public const uint MIDDLEDOWN = 0x20;
  public const uint MIDDLEUP = 0x40;
  public const uint WHEEL = 0x800;
  public const uint KEYUP = 0x02;
}
"@

try { [void][OlkilWin]::SetProcessDPIAware() } catch {}

$procName = if ($args.Count -gt 0 -and $args[0]) { [string]$args[0] } else { 'Code' }

function Get-Hwnd {
  $proc = Get-Process -Name $procName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
  if ($proc) { return [IntPtr]$proc.MainWindowHandle }
  return [IntPtr]::Zero
}

function Get-Rect([IntPtr]$hwnd) {
  $rect = New-Object OlkilWin+RECT
  $ok = [OlkilWin]::GetWindowRect($hwnd, [ref]$rect)
  if (-not $ok) { return $null }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -lt 80 -or $h -lt 80) { return $null }
  return @{ L = $rect.Left; T = $rect.Top; W = $w; H = $h }
}

function Convert-Jpeg([System.Drawing.Bitmap]$bmp) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]86)
  $ms = New-Object System.IO.MemoryStream
  if ($codec) { $bmp.Save($ms, $codec, $params) } else { $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg) }
  $text = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  $params.Dispose()
  return $text
}

function Capture-Frame {
  $hwnd = Get-Hwnd
  $rect = Get-Rect $hwnd
  if (-not $rect) { return '' }
  $bmp = New-Object System.Drawing.Bitmap $rect.W, $rect.H
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $graphics.GetHdc()
  $printed = [OlkilWin]::PrintWindow($hwnd, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  if (-not $printed) {
    $graphics.CopyFromScreen($rect.L, $rect.T, 0, 0, (New-Object System.Drawing.Size $rect.W, $rect.H))
  }
  $graphics.Dispose()
  $max = 1920
  $out = $bmp
  if ($rect.W -gt $max) {
    $nh = [Math]::Max(1, [int]($rect.H * $max / $rect.W))
    $out = New-Object System.Drawing.Bitmap $max, $nh
    $scale = [System.Drawing.Graphics]::FromImage($out)
    $scale.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scale.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scale.DrawImage($bmp, 0, 0, $max, $nh)
    $scale.Dispose()
    $bmp.Dispose()
  }
  $text = Convert-Jpeg $out
  $out.Dispose()
  return $text
}

function Move-Point([double]$x, [double]$y, [bool]$focus) {
  $hwnd = Get-Hwnd
  $rect = Get-Rect $hwnd
  if (-not $rect) { return }
  if ($x -lt 0) { $x = 0 }
  if ($y -lt 0) { $y = 0 }
  if ($x -gt 1) { $x = 1 }
  if ($y -gt 1) { $y = 1 }
  if ($focus) { [void][OlkilWin]::SetForegroundWindow($hwnd) }
  $px = [int]($rect.L + $x * $rect.W)
  $py = [int]($rect.T + $y * $rect.H)
  [void][OlkilWin]::SetCursorPos($px, $py)
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line -eq 'FRAME') {
    $jpeg = Capture-Frame
    if ($jpeg) { [Console]::Out.WriteLine('F ' + $jpeg) }
    else { [Console]::Out.WriteLine('MISS') }
    [Console]::Out.Flush()
    continue
  }
  $parts = $line.Split(' ')
  if ($parts.Length -lt 1) { continue }
  if ($parts[0] -eq 'MOUSE' -and $parts.Length -ge 4) {
    $kind = $parts[1]
    $x = [double]$parts[2]
    $y = [double]$parts[3]
    $button = if ($parts.Length -ge 5) { [int]$parts[4] } else { 0 }
    Move-Point $x $y ($kind -eq 'down')
    $down = [OlkilWin]::LEFTDOWN
    $up = [OlkilWin]::LEFTUP
    if ($button -eq 2) { $down = [OlkilWin]::RIGHTDOWN; $up = [OlkilWin]::RIGHTUP }
    elseif ($button -eq 1) { $down = [OlkilWin]::MIDDLEDOWN; $up = [OlkilWin]::MIDDLEUP }
    if ($kind -eq 'down') { [OlkilWin]::mouse_event($down, 0, 0, 0, 0) }
    elseif ($kind -eq 'up') { [OlkilWin]::mouse_event($up, 0, 0, 0, 0) }
    continue
  }
  if ($parts[0] -eq 'WHEEL' -and $parts.Length -ge 4) {
    Move-Point ([double]$parts[1]) ([double]$parts[2]) $false
    [OlkilWin]::mouse_event([OlkilWin]::WHEEL, 0, 0, [int]$parts[3], 0)
    continue
  }
  if ($parts[0] -eq 'KEY' -and $parts.Length -ge 3) {
    $hwnd = Get-Hwnd
    if ($hwnd -ne [IntPtr]::Zero -and $parts[1] -eq 'down') { [void][OlkilWin]::SetForegroundWindow($hwnd) }
    $vk = [byte]([int]$parts[2] -band 0xff)
    $flags = 0
    if ($parts[1] -eq 'up') { $flags = [OlkilWin]::KEYUP }
    [OlkilWin]::keybd_event($vk, 0, $flags, 0)
  }
}
