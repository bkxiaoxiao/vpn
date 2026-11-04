import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
if (existsSync(".env")) {
  console.log(".env 已存在，保留原密钥。");
  process.exit(0);
}
writeFileSync(
  ".env",
  `LOCAL_DEV=true\nDATA_KEY=${randomBytes(32).toString("hex")}\nPORT=4181\nPUBLIC_BASE_URL=http://127.0.0.1:4181\n`,
  { mode: 0o600, flag: "wx" },
);
console.log("已创建本地 .env（密钥不输出）。运行 npm run dev。");
