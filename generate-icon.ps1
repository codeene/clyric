Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 32x32 icon: dark background + green music note
$bmp   = New-Object System.Drawing.Bitmap(32, 32)
$g     = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(18, 18, 24))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(29, 185, 84))
$font  = New-Object System.Drawing.Font('Segoe UI Symbol', 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.DrawString([char]0x266B, $font, $brush, -2, 2)
$g.Dispose()

$hIcon = $bmp.GetHicon()
$icon  = [System.Drawing.Icon]::FromHandle($hIcon)
$stream = [System.IO.FileStream]::new('icon.ico', [System.IO.FileMode]::Create)
$icon.Save($stream)
$stream.Close()
$icon.Dispose()
$bmp.Dispose()

Write-Host "icon.ico generated"
