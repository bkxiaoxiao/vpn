import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSingBoxConfig } from "../lib/singbox.mjs";

const singBoxPath = process.env.SING_BOX_PATH || [
  "/opt/homebrew/bin/sing-box",
  "/usr/local/bin/sing-box"
].find((candidate) => fs.existsSync(candidate));

test("generated gateway config passes a real sing-box check", { skip: !singBoxPath }, async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "vpn-gateway-check-"));
  try {
    const certificate = path.join(directory, "cert.pem");
    const key = path.join(directory, "key.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", key, "-out", certificate
    ], { stdio: "ignore" });
    const config = buildSingBoxConfig({
      protocol: "ss",
      name: "integration-test",
      server: "example.com",
      port: 8388,
      method: "aes-256-gcm",
      password: "test-password"
    }, {
      proxyPort: 18443,
      proxyUsername: "test-user",
      proxyPassword: "test-password",
      tlsCertPath: certificate,
      tlsKeyPath: key
    });
    const configPath = path.join(directory, "config.json");
    await fsp.writeFile(configPath, JSON.stringify(config));
    const output = execFileSync(singBoxPath, ["check", "-c", configPath], { encoding: "utf8" });
    assert.equal(output, "");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
