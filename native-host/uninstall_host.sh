#!/bin/zsh
set -eu

if [[ "$(uname -s)" == "Darwin" ]]; then
  APP_SUPPORT="$HOME/Library/Application Support/VPN Subscription Manager"
  MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vpnbridge.host.json"
else
  APP_SUPPORT="$HOME/.local/share/vpn-subscription-manager"
  MANIFEST="$HOME/.config/google-chrome/NativeMessagingHosts/com.vpnbridge.host.json"
fi

if [[ -f "$APP_SUPPORT/sing-box.pid" ]]; then
  echo "请先在扩展中断开连接，再运行卸载脚本。"
  exit 1
fi

rm -f "$MANIFEST"
rm -rf "$APP_SUPPORT"
echo "本机桥接已卸载；Chrome 扩展文件没有被删除。"
