import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["VPN_BRIDGE_DATA_DIR"] = TEMP_DIR.name
HOST_PATH = Path(__file__).resolve().parents[1] / "native-host" / "host.py"
SPEC = importlib.util.spec_from_file_location("vpn_native_host", HOST_PATH)
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class HostConfigTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        TEMP_DIR.cleanup()

    def test_builds_shadowsocks_config(self):
        config = host.build_config(
            {
                "protocol": "ss",
                "server": "ss.example.com",
                "port": 8388,
                "method": "aes-256-gcm",
                "password": "secret",
            },
            2080,
        )
        self.assertEqual(config["inbounds"][0]["listen"], "127.0.0.1")
        self.assertEqual(config["outbounds"][0]["type"], "shadowsocks")
        self.assertEqual(config["route"]["final"], "proxy")

    def test_builds_vless_reality_config(self):
        outbound = host.build_outbound(
            {
                "protocol": "vless",
                "server": "vless.example.com",
                "port": 443,
                "uuid": "11111111-1111-1111-1111-111111111111",
                "security": "reality",
                "serverName": "www.example.com",
                "realityPublicKey": "public-key",
                "realityShortId": "01234567",
                "fingerprint": "chrome",
                "transport": "tcp",
                "packetEncoding": "xudp",
                "flow": "xtls-rprx-vision",
            }
        )
        self.assertTrue(outbound["tls"]["reality"]["enabled"])
        self.assertEqual(outbound["tls"]["utls"]["fingerprint"], "chrome")
        self.assertEqual(outbound["flow"], "xtls-rprx-vision")

    def test_rejects_unsupported_transport(self):
        with self.assertRaisesRegex(ValueError, "不支持"):
            host.build_outbound(
                {
                    "protocol": "vless",
                    "server": "example.com",
                    "port": 443,
                    "uuid": "id",
                    "transport": "kcp",
                }
            )

    def test_native_message_status_round_trip(self):
        payload = json.dumps({"action": "status"}).encode("utf-8")
        frame = struct.pack("<I", len(payload)) + payload
        environment = dict(os.environ)
        environment["VPN_BRIDGE_DATA_DIR"] = TEMP_DIR.name
        result = subprocess.run(
            [sys.executable, str(HOST_PATH)],
            input=frame,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            timeout=5,
            check=True,
        )
        response_length = struct.unpack("<I", result.stdout[:4])[0]
        response = json.loads(result.stdout[4:4 + response_length].decode("utf-8"))
        self.assertTrue(response["ok"])
        self.assertIn("available", response)
        self.assertFalse(response["running"])


if __name__ == "__main__":
    unittest.main()
