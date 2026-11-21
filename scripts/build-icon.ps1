# Build the OliviaCode app icon from the in-app Olivia Mark (concentric rings + ticks).
#
# Why PowerShell: the repo is offline and pulls no image libraries; System.Drawing ships with Windows.
# Windows PowerShell 5.1 reads .ps1 as ANSI unless the file has a BOM, so keep this file ASCII-only.
#
# Output:
#   build/icon.png  256x256, for docs/preview
#   build/icon.ico  single 256x256 PNG entry (Windows Vista+ scales it correctly)
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-icon.ps1
[CmdletBinding()]
param(
  [string]$OutDir = ''
)

# $PSScriptRoot is not populated while parameter defaults are evaluated, so resolve it here
# and keep our own copy: it can come back empty later in the run on some hosts.
$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) { $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutDir) { $OutDir = Join-Path $scriptRoot '..\build' }

Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# The icon mirrors icons.tsx viewBox 24: 1 unit = 256/24
$k = $size / 24.0
$ink = [System.Drawing.Color]::FromArgb(255, 20, 22, 26)
$paper = [System.Drawing.Color]::FromArgb(255, 242, 241, 236)

function New-InkPen([System.Drawing.Color]$color, [double]$width) {
  $p = New-Object System.Drawing.Pen $color, ([single]($width * $k))
  $p.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Center
  return $p
}

# Paper plate so the mark reads on both light and dark desktops
$plate = New-Object System.Drawing.SolidBrush $paper
$g.FillEllipse($plate, 6, 6, $size - 12, $size - 12)
$plate.Dispose()

$c = $size / 2.0

# Three rings: outer faint, inner heavy
$rings = @(
  @{ r = 10.3; w = 0.9;  a = 110 },
  @{ r = 7.3;  w = 1.15; a = 255 },
  @{ r = 3.5;  w = 1.8;  a = 255 }
)
foreach ($ring in $rings) {
  $color = [System.Drawing.Color]::FromArgb($ring.a, $ink.R, $ink.G, $ink.B)
  $pen = New-InkPen $color $ring.w
  $rr = $ring.r * $k
  $g.DrawEllipse($pen, ($c - $rr), ($c - $rr), ($rr * 2), ($rr * 2))
  $pen.Dispose()
}

# Center dot + the small offset dot
$dot = New-Object System.Drawing.SolidBrush $ink
$g.FillEllipse($dot, ($c - 1.05 * $k), ($c - 1.05 * $k), (2.1 * $k), (2.1 * $k))
$g.FillEllipse($dot, ((16.6 - 0.95) * $k), ((7.4 - 0.95) * $k), (1.9 * $k), (1.9 * $k))
$dot.Dispose()

# Four ticks
$tick = New-InkPen ([System.Drawing.Color]::FromArgb(128, $ink.R, $ink.G, $ink.B)) 0.9
$g.DrawLine($tick, ($c), (1.7 * $k), ($c), (3.1 * $k))
$g.DrawLine($tick, ($c), (20.9 * $k), ($c), (22.3 * $k))
$g.DrawLine($tick, (1.7 * $k), ($c), (3.1 * $k), ($c))
$g.DrawLine($tick, (20.9 * $k), ($c), (22.3 * $k), ($c))
$tick.Dispose()

$g.Dispose()

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pngPath = Join-Path $OutDir 'icon.png'
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# Assemble ICO: ICONDIR(6) + ICONDIRENTRY(16) + PNG payload
$png = [System.IO.File]::ReadAllBytes($pngPath)
$icoPath = Join-Path $OutDir 'icon.ico'
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([uint16]0)        # reserved
$writer.Write([uint16]1)        # type = icon
$writer.Write([uint16]1)        # count
$writer.Write([byte]0)          # width 0 means 256
$writer.Write([byte]0)          # height 0 means 256
$writer.Write([byte]0)          # palette
$writer.Write([byte]0)          # reserved
$writer.Write([uint16]1)        # color planes
$writer.Write([uint16]32)       # bits per pixel
$writer.Write([uint32]$png.Length)
$writer.Write([uint32]22)       # offset = 6 + 16
$writer.Write($png)
$writer.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $stream.ToArray())
$writer.Dispose()
$stream.Dispose()
$bitmap.Dispose()

Write-Output "icon.png -> $pngPath ($($png.Length) bytes)"
Write-Output "icon.ico -> $icoPath ($((Get-Item $icoPath).Length) bytes)"

# Dev builds want the window icon too: drop a copy into apps/desktop/dist when it exists.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.
$devDist = Join-Path $scriptRoot '..\apps\desktop\dist'
if (Test-Path $devDist) {
  Copy-Item $pngPath (Join-Path $devDist 'icon.png') -Force
  Write-Output "icon.png -> $(Join-Path $devDist 'icon.png')"
}
