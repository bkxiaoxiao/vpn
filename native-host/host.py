#!/usr/bin/env python3
"""Native Messaging bridge between the Chrome extension and sing-box."""

import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


HOST_NAME = "com.vpnbridge.host"
MAX_MESSAGE_BYTES = 900 * 1024


def default_app_dir():
    if sys.platform == "darwin":
        return str(Path.home() / "Library" / "Application Support" / "VPN Subscription Manager")
    return str(Path.home() / ".local" / "share" / "vpn-subscription-manager")


APP_DIR = Path(os.environ.get("VPN_BRIDGE_DATA_DIR", default_app_dir()))
SETTINGS_PATH = APP_DIR / "settings.json"
CONFIG_PATH = APP_DIR / "sing-box.json"
PID_PATH = APP_DIR / "sing-box.pid"
STATE_PATH = APP_DIR / "state.json"
LOG_PATH = APP_DIR / "sing-box.log"


def main():
    try:
        request = read_message()
        if request is None:
            return
        response = dispatch(request)
        write_message({"ok": True, **response})
    except Exception as error:  # Native hosts must always return structured errors.
        write_message({"ok": False, "error": str(error)})


def dispatch(request):
    action = request.get("action")
    if action == "status":
        return status()
    if action == "fetch":
        return {"content": fetch_subscription(request.get("url", ""))}
    if action == "start":
        return start_sing_box(request.get("node"), request.get("port"))
    if action == "stop":
        stopped = stop_sing_box()
        return {"available": locate_sing_box() is not None, "running": False, "stopped": stopped}
    raise ValueError("未知的本机桥接操作")


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    if len(raw_length) != 4:
        raise ValueError("Native Messaging 消息头无效")
    length = struct.unpack("<I", raw_length)[0]
    if length <= 0 or length > MAX_MESSAGE_BYTES:
        raise ValueError("Native Messaging 请求过大")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("Native Messaging 消息不完整")
    return json.loads(payload.decode("utf-8"))


def write_message(message):
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_MESSAGE_BYTES:
        payload = json.dumps({"ok": False, "error": "订阅响应过大，请缩小订阅或拆分订阅"}, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def status():
    binary = locate_sing_box()
    running = process_is_running()
    state = read_json(STATE_PATH, {})
    return {
        "available": binary is not None,
        "running": running,
        "version": sing_box_version(binary) if binary else "",
        "nodeName": state.get("nodeName", "") if running else "",
        "port": state.get("port") if running else None,
    }


def fetch_subscription(url):
    if not isinstance(url, str) or not url.lower().startswith(("https://", "http://")):
        raise ValueError("订阅地址必须以 http:// 或 https:// 开头")
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Clash.Meta/1.19 VPN-Subscription-Manager/0.1",
            "Accept": "text/plain, application/octet-stream, */*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(MAX_MESSAGE_BYTES + 1)
            if len(data) > MAX_MESSAGE_BYTES:
                raise ValueError("订阅内容超过 900 KB，请拆分订阅")
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                return data.decode(charset)
            except (LookupError, UnicodeDecodeError):
                return data.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        raise ValueError("订阅服务器返回 HTTP {}".format(error.code))
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        raise ValueError("无法获取订阅：{}".format(reason))


def start_sing_box(node, port):
    binary = locate_sing_box()
    if not binary:
        raise ValueError("找不到 sing-box，请先安装并重新运行本机桥接安装脚本")
    if not isinstance(node, dict):
        raise ValueError("节点信息无效")
    try:
        port = int(port)
    except (TypeError, ValueError):
        raise ValueError("本地端口无效")
    if port < 1024 or port > 65535:
        raise ValueError("本地端口需在 1024–65535 之间")

    ensure_app_dir()
    config = build_config(node, port)
    write_private_json(CONFIG_PATH, config)
    check = subprocess.run(
        [binary, "check", "-c", str(CONFIG_PATH)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=10,
    )
    if check.returncode != 0:
        detail = clean_error(check.stdout)
        raise ValueError("sing-box 配置检查失败：{}".format(detail))

    stop_sing_box()
    log_file = open(LOG_PATH, "ab", buffering=0)
    try:
        process = subprocess.Popen(
            [binary, "run", "-c", str(CONFIG_PATH)],
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        log_file.close()

    PID_PATH.write_text(str(process.pid), encoding="utf-8")
    os.chmod(PID_PATH, 0o600)
    write_private_json(STATE_PATH, {"nodeName": node.get("name", "节点"), "port": port})

    deadline = time.time() + 3.0
    while time.time() < deadline:
        if process.poll() is not None:
            PID_PATH.unlink(missing_ok=True)
            raise ValueError("sing-box 启动失败：{}".format(tail_log()))
        if port_is_open(port):
            return {
                "available": True,
                "running": True,
                "version": sing_box_version(binary),
                "nodeName": node.get("name", "节点"),
                "port": port,
            }
        time.sleep(0.1)

    stop_sing_box()
    raise ValueError("sing-box 启动超时，请查看 {}".format(LOG_PATH))


def stop_sing_box():
    pid = read_pid()
    if not pid:
        PID_PATH.unlink(missing_ok=True)
        return False
    if not pid_matches_sing_box(pid):
        PID_PATH.unlink(missing_ok=True)
        return False

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        PID_PATH.unlink(missing_ok=True)
        return False

    deadline = time.time() + 2.0
    while time.time() < deadline:
        if not process_exists(pid):
            PID_PATH.unlink(missing_ok=True)
            return True
        time.sleep(0.08)

    if pid_matches_sing_box(pid):
        os.kill(pid, signal.SIGKILL)
    PID_PATH.unlink(missing_ok=True)
    return True


def build_config(node, port):
    outbound = build_outbound(node)
    return {
        "log": {"level": "warn", "timestamp": True},
        "inbounds": [
            {
                "type": "mixed",
                "tag": "chrome-in",
                "listen": "127.0.0.1",
                "listen_port": port,
                "set_system_proxy": False,
            }
        ],
        "outbounds": [outbound],
        "route": {
            "rules": [{"action": "sniff"}],
            "final": "proxy",
            "auto_detect_interface": True,
        },
    }


def build_outbound(node):
    protocol = node.get("protocol")
    server = required_text(node, "server", "节点缺少服务器地址")
    server_port = required_port(node.get("port"))

    if protocol == "ss":
        outbound = {
            "type": "shadowsocks",
            "tag": "proxy",
            "server": server,
            "server_port": server_port,
            "method": required_text(node, "method", "Shadowsocks 节点缺少加密方式"),
            "password": required_text(node, "password", "Shadowsocks 节点缺少密码"),
        }
        plugin = node.get("plugin", "")
        if plugin:
            if plugin not in ("obfs-local", "v2ray-plugin"):
                raise ValueError("sing-box 不支持 Shadowsocks 插件 {}".format(plugin))
            outbound["plugin"] = plugin
            if node.get("pluginOpts"):
                outbound["plugin_opts"] = node["pluginOpts"]
        return outbound

    if protocol == "vless":
        outbound = {
            "type": "vless",
            "tag": "proxy",
            "server": server,
            "server_port": server_port,
            "uuid": required_text(node, "uuid", "VLESS 节点缺少 UUID"),
        }
        if node.get("flow"):
            if node["flow"] != "xtls-rprx-vision":
                raise ValueError("sing-box 不支持 VLESS flow={}".format(node["flow"]))
            outbound["flow"] = node["flow"]
        if node.get("packetEncoding"):
            outbound["packet_encoding"] = node["packetEncoding"]
        tls = build_tls(node, server)
        if tls:
            outbound["tls"] = tls
        transport = build_transport(node)
        if transport:
            outbound["transport"] = transport
        return outbound

    raise ValueError("仅支持 Shadowsocks 和 VLESS 节点")


def build_tls(node, server):
    security = str(node.get("security", "none")).lower()
    if security == "none":
        return None
    if security not in ("tls", "reality"):
        raise ValueError("不支持 VLESS security={}".format(security))

    tls = {
        "enabled": True,
        "server_name": node.get("serverName") or server,
        "insecure": bool(node.get("allowInsecure", False)),
    }
    if node.get("alpn"):
        tls["alpn"] = node["alpn"]
    if node.get("fingerprint"):
        tls["utls"] = {"enabled": True, "fingerprint": node["fingerprint"]}
    if security == "reality":
        public_key = required_text(node, "realityPublicKey", "Reality 节点缺少公钥 pbk")
        tls["reality"] = {
            "enabled": True,
            "public_key": public_key,
            "short_id": node.get("realityShortId", ""),
        }
    return tls


def build_transport(node):
    transport = str(node.get("transport", "tcp")).lower()
    if transport == "tcp":
        header_type = str(node.get("headerType", "")).lower()
        if header_type not in ("", "none"):
            raise ValueError("sing-box 不支持 VLESS TCP headerType={}".format(header_type))
        return None
    if transport == "ws":
        result = {"type": "ws", "path": node.get("path") or "/"}
        if node.get("host"):
            result["headers"] = {"Host": node["host"]}
        return result
    if transport == "grpc":
        return {"type": "grpc", "service_name": node.get("serviceName", "")}
    if transport == "http":
        result = {"type": "http", "path": node.get("path") or "/"}
        if node.get("host"):
            result["host"] = [item.strip() for item in node["host"].split(",") if item.strip()]
        return result
    if transport == "httpupgrade":
        return {
            "type": "httpupgrade",
            "host": node.get("host", ""),
            "path": node.get("path") or "/",
        }
    if transport == "quic":
        return {"type": "quic"}
    raise ValueError("sing-box 不支持 VLESS {} 传输".format(transport))


def locate_sing_box():
    settings = read_json(SETTINGS_PATH, {})
    configured = settings.get("sing_box_path")
    if configured and Path(configured).is_file() and os.access(configured, os.X_OK):
        return configured
    return shutil.which("sing-box")


def sing_box_version(binary):
    try:
        result = subprocess.run(
            [binary, "version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=3,
        )
        first_line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        return first_line.replace("sing-box version ", "")[:80]
    except (OSError, subprocess.SubprocessError):
        return "已安装"


def process_is_running():
    pid = read_pid()
    return bool(pid and pid_matches_sing_box(pid))


def read_pid():
    try:
        pid = int(PID_PATH.read_text(encoding="utf-8").strip())
        return pid if pid > 1 else None
    except (OSError, ValueError):
        return None


def pid_matches_sing_box(pid):
    if not process_exists(pid):
        return False
    try:
        command = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "command="],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip()
        return "sing-box" in command and str(CONFIG_PATH) in command
    except (OSError, subprocess.SubprocessError):
        return False


def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def port_is_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.15):
            return True
    except OSError:
        return False


def ensure_app_dir():
    APP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(APP_DIR, 0o700)
    except OSError:
        pass


def write_private_json(path, value):
    ensure_app_dir()
    descriptor, temporary = tempfile.mkstemp(prefix=".tmp-", dir=str(APP_DIR))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def required_text(node, key, message):
    value = node.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(message)
    return value


def required_port(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError("节点端口无效")
    if port < 1 or port > 65535:
        raise ValueError("节点端口无效")
    return port


def clean_error(value):
    lines = [line.strip() for line in (value or "").splitlines() if line.strip()]
    return (lines[-1] if lines else "未知配置错误")[-1000:]


def tail_log():
    try:
        return clean_error(LOG_PATH.read_text(encoding="utf-8", errors="replace")[-4000:])
    except OSError:
        return "没有生成日志"


if __name__ == "__main__":
    main()
