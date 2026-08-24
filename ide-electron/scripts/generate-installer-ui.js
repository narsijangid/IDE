/**
 * Builds NSIS bitmaps (exact 164x314 / 150x57, 24-bit BMP).
 * Installer-only — not copied into the IDE asar.
 *
 * Usage: node scripts/generate-installer-ui.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const logo = path.join(root, 'build', 'icon', 'olkilmainlogo.png');
const sidebarOut = path.join(root, 'build', 'installerSidebar.bmp');
const headerOut = path.join(root, 'build', 'installerHeader.bmp');

if (!fs.existsSync(logo)) {
  throw new Error('Missing ' + logo);
}

const ps1 = `
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function Save-Bmp24([System.Drawing.Bitmap]$src, [string]$dest, [int]$w, [int]$h) {
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $bmp24 = $src.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $bmp24.Save($dest, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp24.Dispose()
}

$black = [System.Drawing.Color]::FromArgb(10, 10, 10)
$pink = [System.Drawing.Color]::FromArgb(254, 1, 154)
$pinkSoft = [System.Drawing.Color]::FromArgb(55, 254, 1, 154)
$white = [System.Drawing.Color]::FromArgb(255, 255, 255)
$muted = [System.Drawing.Color]::FromArgb(180, 180, 188)
$blackBrush = New-Object System.Drawing.SolidBrush $black
$pinkBrush = New-Object System.Drawing.SolidBrush $pink
$pinkSoftBrush = New-Object System.Drawing.SolidBrush $pinkSoft
$whiteBrush = New-Object System.Drawing.SolidBrush $white
$mutedBrush = New-Object System.Drawing.SolidBrush $muted
$logoImg = [System.Drawing.Image]::FromFile('${logo.replace(/\\/g, '\\\\')}')

# —— Sidebar 164 x 314 ——
$side = New-Object System.Drawing.Bitmap 164, 314, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($side)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear($black)
$g.FillRectangle($pinkBrush, 0, 0, 164, 4)
$g.FillEllipse($pinkSoftBrush, 18, 42, 128, 128)
$logoSize = 96
$logoX = [int]((164 - $logoSize) / 2)
$g.DrawImage($logoImg, $logoX, 48, $logoSize, $logoSize)

$titleFont = New-Object System.Drawing.Font 'Segoe UI', 15, ([System.Drawing.FontStyle]::Bold)
$subFont = New-Object System.Drawing.Font 'Segoe UI', 8
$sf = [System.Drawing.StringFormat]::GenericTypographic
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$titleRect = New-Object System.Drawing.RectangleF 0, 158, 164, 28
$g.DrawString('OLKIL', $titleFont, $whiteBrush, $titleRect, $sf)
$g.FillRectangle($pinkBrush, 58, 190, 48, 2)
$subRect = New-Object System.Drawing.RectangleF 8, 200, 148, 36
$g.DrawString('AI Code Editor', $subFont, $mutedBrush, $subRect, $sf)
$urlRect = New-Object System.Drawing.RectangleF 0, 284, 164, 20
$g.DrawString('olkil.com', $subFont, $pinkBrush, $urlRect, $sf)
$g.FillRectangle($pinkBrush, 0, 310, 164, 4)
$g.Dispose()
Save-Bmp24 $side '${sidebarOut.replace(/\\/g, '\\\\')}' 164 314
$side.Dispose()

# —— Header 150 x 57 (MUI_HEADERIMAGE_RIGHT) ——
$head = New-Object System.Drawing.Bitmap 150, 57, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$hg = [System.Drawing.Graphics]::FromImage($head)
$hg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$hg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$hg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$hg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$hg.Clear($black)
$icon = 32
$iconX = [int]((150 - $icon) / 2)
$hg.DrawImage($logoImg, $iconX, 10, $icon, $icon)
$hg.FillRectangle($pinkBrush, 0, 54, 150, 3)
$hg.Dispose()
Save-Bmp24 $head '${headerOut.replace(/\\/g, '\\\\')}' 150 57
$head.Dispose()

$logoImg.Dispose()
$titleFont.Dispose()
$subFont.Dispose()
$blackBrush.Dispose()
$pinkBrush.Dispose()
$pinkSoftBrush.Dispose()
$whiteBrush.Dispose()
$mutedBrush.Dispose()
Write-Output 'ok'
`;

const tmp = path.join(root, 'build', '.gen-installer-ui.ps1');
fs.writeFileSync(tmp, ps1, 'utf8');
const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
  { encoding: 'utf8' },
);
try {
  fs.unlinkSync(tmp);
} catch {
  // ignore
}
if (result.status !== 0) {
  console.error(result.stdout || '');
  console.error(result.stderr || '');
  throw new Error('Failed to generate installer bitmaps');
}
if (!fs.existsSync(sidebarOut) || !fs.existsSync(headerOut)) {
  throw new Error('Installer bitmaps were not written');
}
console.log('[installer-ui] wrote', path.relative(root, sidebarOut));
console.log('[installer-ui] wrote', path.relative(root, headerOut));
