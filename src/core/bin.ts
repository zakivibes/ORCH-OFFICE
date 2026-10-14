import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function resolveBinary(name: string): string {
  if (name === "opencode") {
    if (process.env.ORCH_OPENCODE_BIN && existsSync(process.env.ORCH_OPENCODE_BIN)) {
      return process.env.ORCH_OPENCODE_BIN;
    }
  }
  if (name === "agy") {
    if (process.env.ORCH_AGY_BIN && existsSync(process.env.ORCH_AGY_BIN)) {
      return process.env.ORCH_AGY_BIN;
    }
  }

  if (process.platform === "win32") {
    if (name === "opencode") {
      const v1 = join(
        process.env.LOCALAPPDATA ?? "",
        "opencode-v1",
        "node_modules",
        "opencode-ai",
        "bin",
        "opencode.exe",
      );
      if (existsSync(v1)) return v1;

      const npmV2 = join(
        process.env.APPDATA ?? "",
        "npm",
        "node_modules",
        "@opencode",
        "cli",
        "bin",
        "opencode.exe",
      );
      if (existsSync(npmV2)) return npmV2;
    }

    if (name === "agy") {
      const agyLocal = join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe");
      if (existsSync(agyLocal)) return agyLocal;
    }

    try {
      const lines = execFileSync("where.exe", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      const exe = lines.find((l) => l.toLowerCase().endsWith(".exe"));
      if (exe && existsSync(exe)) return exe;

      const cmd = lines.find(
        (l) => l.toLowerCase().endsWith(".cmd") || l.toLowerCase().endsWith(".bat"),
      );
      if (cmd && existsSync(cmd)) return cmd;

      if (lines[0] && existsSync(lines[0])) return lines[0];
    } catch {
      // not on PATH
    }
  }

  return name;
}
