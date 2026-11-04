#!/bin/zsh
set -eu

EXTENSION_ID="${1:-}"
SING_BOX_PATH="${2:-}"

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "用法: ./install_host.sh <Chrome 扩展 ID> [sing-box 路径]"
  exit 1
fi

if [[ -z "$SING_BOX_PATH" ]]; then
  SING_BOX_PATH="$(command -v sing-box || true)"
fi

if [[ -z "$SING_BOX_PATH" || ! -x "$SING_BOX_PATH" ]]; then
  echo "找不到 sing-box。请先安装，或把可执行文件路径作为第二个参数传入。"
  exit 1
fi

PYTHON_PATH="$(command -v python3 || true)"
if [[ -z "$PYTHON_PATH" || ! -x "$PYTHON_PATH" ]]; then
  echo "找不到 Python 3，请先安装 Python 3。"
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(uname -s)" == "Darwin" ]]; then
  APP_SUPPORT="$HOME/Library/Application Support/VPN Subscription Manager"
  MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  APP_SUPPORT="$HOME/.local/share/vpn-subscription-manager"
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

mkdir -p "$APP_SUPPORT" "$MANIFEST_DIR"
chmod 700 "$APP_SUPPORT"
cp "$SOURCE_DIR/host.py" "$APP_SUPPORT/host.py"
cp "$SOURCE_DIR/native_host_launcher.sh" "$APP_SUPPORT/native_host_launcher.sh"
chmod 700 "$APP_SUPPORT/host.py" "$APP_SUPPORT/native_host_launcher.sh"
print -r -- "$PYTHON_PATH" > "$APP_SUPPORT/python_path"
chmod 600 "$APP_SUPPORT/python_path"

"$PYTHON_PATH" -c '
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({"sing_box_path": sys.argv[2]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
' "$APP_SUPPORT/settings.json" "$SING_BOX_PATH"
chmod 600 "$APP_SUPPORT/settings.json"

"$PYTHON_PATH" -c '
import json, pathlib, sys
manifest = {
    "name": "com.vpnbridge.host",
    "description": "节点订阅助手的 sing-box 本机桥接",
    "path": sys.argv[2],
    "type": "stdio",
    "allowed_origins": ["chrome-extension://{}/".format(sys.argv[3])],
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
' "$MANIFEST_DIR/com.vpnbridge.host.json" "$APP_SUPPORT/native_host_launcher.sh" "$EXTENSION_ID"
chmod 600 "$MANIFEST_DIR/com.vpnbridge.host.json"

echo "本机桥接安装完成。请在 chrome://extensions 中重新加载扩展。"
echo "sing-box: $SING_BOX_PATH"
