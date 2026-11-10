#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
dotnet_cmd=${DOTNET_COMMAND:-"$root/.tools/dotnet/dotnet"}
nsis_cmd=${MAKENSIS_COMMAND:-"$root/.tools/nsis/makensis/3.13/bin/makensis"}
if [ ! -x "$dotnet_cmd" ]; then dotnet_cmd=$(command -v dotnet); fi
if [ ! -x "$nsis_cmd" ]; then nsis_cmd=$(command -v makensis); fi
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
export DOTNET_CLI_HOME="$root/.tools/cli"
export NUGET_PACKAGES="$root/.tools/packages"
python3 scripts/fetch-core.py
"$dotnet_cmd" publish src/RelayEnterprise/RelayEnterprise.csproj -c Release -r win-x64 --self-contained true -o "$root/dist/app"
mkdir -p dist/app/core
cp .tools/sing-box.exe dist/app/core/sing-box.exe
cp ../mac-client/Resources/sing-box-LICENSE.txt dist/app/sing-box-LICENSE.txt
cp Resources/THIRD_PARTY_NOTICES.txt dist/app/RELAY_THIRD_PARTY_NOTICES.txt
cp Resources/安装与测试.txt dist/app/安装与测试.txt
if [ -d "$root/.tools/nsis/makensis/3.13/share/nsis" ]; then export NSISDIR="$root/.tools/nsis/makensis/3.13/share/nsis"; fi
python3 scripts/make-uninstall-manifest.py "$root/dist/app" "$root/dist/uninstall-files.nsh"
"$nsis_cmd" -INPUTCHARSET UTF8 -DAPP_DIR="$root/dist/app" -DUNINSTALL_MANIFEST="$root/dist/uninstall-files.nsh" -DOUT_FILE="$root/dist/Relay-Enterprise-0.1.3-Windows-x64-Setup.exe" installer/Relay.nsi
python3 - <<'PY'
import hashlib, pathlib, zipfile
root = pathlib.Path('dist')
archive = root / 'Relay-Enterprise-0.1.3-Windows-x64-Portable.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted((root/'app').rglob('*')):
        if path.is_file(): package.write(path, path.relative_to(root/'app'))
outputs = [root/'Relay-Enterprise-0.1.3-Windows-x64-Setup.exe', archive]
(root/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in outputs))
print({p.name: p.stat().st_size for p in outputs})
PY
