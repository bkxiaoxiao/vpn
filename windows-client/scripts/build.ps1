$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    & (Join-Path $PSScriptRoot 'fetch-core.ps1')
    $app = Join-Path $root 'dist/app'
    dotnet publish src/RelayEnterprise/RelayEnterprise.csproj -c Release -r win-x64 --self-contained true -o $app
    if ($LASTEXITCODE -ne 0) { throw 'Publish failed' }
    New-Item -ItemType Directory -Force (Join-Path $app 'core') | Out-Null
    Copy-Item .tools/sing-box.exe (Join-Path $app 'core/sing-box.exe') -Force
    Copy-Item ../mac-client/Resources/sing-box-LICENSE.txt (Join-Path $app 'sing-box-LICENSE.txt') -Force
    Copy-Item Resources/THIRD_PARTY_NOTICES.txt (Join-Path $app 'RELAY_THIRD_PARTY_NOTICES.txt') -Force
    Copy-Item Resources/安装与测试.txt (Join-Path $app '安装与测试.txt') -Force
    $installer = Join-Path $root 'dist/Relay-Enterprise-0.1.3-Windows-x64-Setup.exe'
    $makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
    if (!$makensis) { $makensis = Join-Path ${env:ProgramFiles(x86)} 'NSIS/makensis.exe' }
    if (!(Test-Path $makensis)) { throw 'Install NSIS 3.x before building the installer' }
    $manifest = Join-Path $root 'dist/uninstall-files.nsh'
    python scripts/make-uninstall-manifest.py $app $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall manifest failed' }
    & $makensis /INPUTCHARSET UTF8 "/DAPP_DIR=$app" "/DUNINSTALL_MANIFEST=$manifest" "/DOUT_FILE=$installer" installer/Relay.nsi
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
    Compress-Archive -Path "$app/*" -DestinationPath dist/Relay-Enterprise-0.1.3-Windows-x64-Portable.zip -Force
    Get-ChildItem dist -File | Where-Object { $_.Extension -in '.exe', '.zip' } | ForEach-Object { $hash = Get-FileHash $_.FullName -Algorithm SHA256; "$($hash.Hash.ToLowerInvariant())  $($_.Name)" } | Set-Content dist/SHA256SUMS.txt -Encoding ascii
} finally { Pop-Location }
