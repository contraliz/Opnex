$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourcePath = Join-Path $repositoryRoot 'opnex-icon-grid-1_5-margin.svg'
$desktopPath = Join-Path $repositoryRoot 'desktop'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "The supplied Opnex SVG was not found: $sourcePath"
}

Add-Type -AssemblyName System.Drawing
$svg = [System.Xml.XmlDocument]::new()
$svg.XmlResolver = $null
$svg.Load($sourcePath)
$svgRoot = $svg.DocumentElement
$viewBox = @($svgRoot.GetAttribute('viewBox') -split '\s+' | ForEach-Object { [double]::Parse($_, [System.Globalization.CultureInfo]::InvariantCulture) })
if ($svgRoot.LocalName -ne 'svg' -or $viewBox.Count -ne 4 -or $viewBox[2] -le 0 -or $viewBox[3] -le 0) {
  throw "The supplied Opnex SVG needs a valid viewBox: $sourcePath"
}
$namespace = [System.Xml.XmlNamespaceManager]::new($svg.NameTable)
$namespace.AddNamespace('svg', $svgRoot.NamespaceURI)
$rectangles = @($svg.SelectNodes('/svg:svg/svg:rect', $namespace))
if ($rectangles.Count -eq 0 -or $svg.SelectNodes('/svg:svg/*[not(self::svg:rect)]', $namespace).Count -gt 0) {
  throw "The Opnex icon generator only supports the supplied rectangle-based SVG: $sourcePath"
}
$viewX, $viewY, $viewWidth, $viewHeight = $viewBox
$pngBySize = @{}
foreach ($size in @(16, 32, 48, 64, 128, 256, 512, 1024)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  foreach ($rectangle in $rectangles) {
    $x = if ($rectangle.HasAttribute('x')) { [double]::Parse($rectangle.GetAttribute('x'), [System.Globalization.CultureInfo]::InvariantCulture) } else { 0 }
    $y = if ($rectangle.HasAttribute('y')) { [double]::Parse($rectangle.GetAttribute('y'), [System.Globalization.CultureInfo]::InvariantCulture) } else { 0 }
    $width = [double]::Parse($rectangle.GetAttribute('width'), [System.Globalization.CultureInfo]::InvariantCulture)
    $height = [double]::Parse($rectangle.GetAttribute('height'), [System.Globalization.CultureInfo]::InvariantCulture)
    $left = [int][Math]::Round(($x - $viewX) * $size / $viewWidth, [MidpointRounding]::AwayFromZero)
    $top = [int][Math]::Round(($y - $viewY) * $size / $viewHeight, [MidpointRounding]::AwayFromZero)
    $right = [int][Math]::Round(($x + $width - $viewX) * $size / $viewWidth, [MidpointRounding]::AwayFromZero)
    $bottom = [int][Math]::Round(($y + $height - $viewY) * $size / $viewHeight, [MidpointRounding]::AwayFromZero)
    $color = [System.Drawing.ColorTranslator]::FromHtml($rectangle.GetAttribute('fill'))
    $brush = [System.Drawing.SolidBrush]::new($color)
    $graphics.FillRectangle($brush, $left, $top, $right - $left, $bottom - $top)
    $brush.Dispose()
  }
  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBySize[$size] = [byte[]]$stream.ToArray()
  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

# ICO stores PNG frames for modern Windows shell support.
$icoSizes = @(16, 32, 48, 64, 256)
$icoStream = [System.IO.MemoryStream]::new()
$icoWriter = [System.IO.BinaryWriter]::new($icoStream)
$icoWriter.Write([UInt16]0)
$icoWriter.Write([UInt16]1)
$icoWriter.Write([UInt16]$icoSizes.Count)
$icoOffset = 6 + 16 * $icoSizes.Count
foreach ($size in $icoSizes) {
  $frame = [byte[]]$pngBySize[$size]
  $dimension = if ($size -eq 256) { 0 } else { $size }
  $icoWriter.Write([byte]$dimension)
  $icoWriter.Write([byte]$dimension)
  $icoWriter.Write([byte]0)
  $icoWriter.Write([byte]0)
  $icoWriter.Write([UInt16]1)
  $icoWriter.Write([UInt16]32)
  $icoWriter.Write([UInt32]$frame.Length)
  $icoWriter.Write([UInt32]$icoOffset)
  $icoOffset += $frame.Length
}
foreach ($size in $icoSizes) { $icoWriter.Write([byte[]]$pngBySize[$size]) }
$icoWriter.Dispose()
[System.IO.File]::WriteAllBytes((Join-Path $desktopPath 'opnex.ico'), $icoStream.ToArray())
$icoStream.Dispose()

function Write-BigEndianUInt32([System.IO.BinaryWriter]$writer, [UInt32]$value) {
  $writer.Write([byte](($value -shr 24) -band 255))
  $writer.Write([byte](($value -shr 16) -band 255))
  $writer.Write([byte](($value -shr 8) -band 255))
  $writer.Write([byte]($value -band 255))
}

# ICNS uses PNG frames with size-specific chunk names.
$icnsTypes = @{ 16 = 'icp4'; 32 = 'icp5'; 64 = 'icp6'; 128 = 'ic07'; 256 = 'ic08'; 512 = 'ic09'; 1024 = 'ic10' }
$icnsStream = [System.IO.MemoryStream]::new()
$icnsWriter = [System.IO.BinaryWriter]::new($icnsStream)
$icnsWriter.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
$icnsLengthOffset = $icnsStream.Position
$icnsWriter.Write([UInt32]0)
foreach ($size in @(16, 32, 64, 128, 256, 512, 1024)) {
  $frame = [byte[]]$pngBySize[$size]
  $icnsWriter.Write([System.Text.Encoding]::ASCII.GetBytes($icnsTypes[$size]))
  Write-BigEndianUInt32 $icnsWriter ([UInt32]($frame.Length + 8))
  $icnsWriter.Write($frame)
}
$icnsLength = [UInt32]$icnsStream.Length
$icnsStream.Position = $icnsLengthOffset
Write-BigEndianUInt32 $icnsWriter $icnsLength
$icnsWriter.Dispose()
[System.IO.File]::WriteAllBytes((Join-Path $desktopPath 'opnex.icns'), $icnsStream.ToArray())
$icnsStream.Dispose()

[System.IO.File]::WriteAllBytes((Join-Path $desktopPath 'opnex-tray-icon.png'), [byte[]]$pngBySize[128])
Write-Output 'Generated Opnex desktop and tray icons from the supplied SVG.'
