$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$zip = Join-Path $tools 'sing-box-1.13.21-windows-amd64.zip'
$expected = 'a03291793d3a3c6e266447a58140657ac099ff278abf3b8ff678932356a62ced'
if (!(Test-Path $zip) -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    Invoke-WebRequest 'https://github.com/SagerNet/sing-box/releases/download/v1.13.21/sing-box-1.13.21-windows-amd64.zip' -OutFile $zip
}
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Core archive checksum mismatch' }
$expanded = Join-Path $tools 'core-expanded'
Expand-Archive $zip $expanded -Force
Copy-Item (Get-ChildItem $expanded -Filter sing-box.exe -Recurse | Select-Object -First 1).FullName (Join-Path $tools 'sing-box.exe') -Force
