// User-adjustable settings and the paths this tool touches.

import os from "node:os";
import { join } from "node:path";
import type { ModelEntry } from "./catalog";
import type { Platform } from "./platform";
import { exists, which } from "./sys";

export interface Settings {
  entry: ModelEntry;
  context: number; // tokens; OpenCode needs at least ~64K
  port: number;
  listen: string; // 127.0.0.1 (this machine) or 0.0.0.0 (network)
}

export const DEFAULTS = { context: 65_536, port: 11_434, listen: "127.0.0.1" } as const;

export const REQUIRED_DISK_MARGIN_GB = 5;

const home = os.homedir();

export const paths = {
  opencodeConfig: join(home, ".config", "opencode", "opencode.json"),
  opencodeBin: join(home, ".opencode", "bin", "opencode"),
  launchAgentLabel: "com.local.ollama",
  launchAgent: join(home, "Library", "LaunchAgents", "com.local.ollama.plist"),
  macLog: join(home, "Library", "Logs", "ollama.log"),
  systemdDropin: "/etc/systemd/system/ollama.service.d/override.conf",
  userUnit: join(home, ".config", "systemd", "user", "ollama.service"),
  plainLog: join(home, ".local", "state", "ollama", "ollama.log"),
};

export const MARKER = "Managed by local-coder";

export const ollamaUrl = (s: Settings) => `http://127.0.0.1:${s.port}`;

/** Environment for the Ollama server process. */
export function serverEnv(s: Settings): Record<string, string> {
  return {
    OLLAMA_HOST: `${s.listen}:${s.port}`,
    OLLAMA_CONTEXT_LENGTH: String(s.context),
    OLLAMA_KEEP_ALIVE: "-1",
    OLLAMA_FLASH_ATTENTION: "1",
  };
}

/** Environment for `ollama` CLI calls made by this tool (points at our port). */
export const clientEnv = (s: Settings) => ({ OLLAMA_HOST: `127.0.0.1:${s.port}` });

export const hasSystemd = () => Boolean(which("systemctl")) && exists("/run/systemd/system");

/** Where Ollama stores models for the service we will configure. */
export function modelsDir(p: Platform, hasSystemUnit: boolean): string {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  if (p.os === "linux" && hasSystemd() && (hasSystemUnit || !which("ollama"))) {
    return "/usr/share/ollama/.ollama/models"; // official installer's service user
  }
  return join(home, ".ollama", "models");
}

export function opencodeInstalled(): boolean {
  return Boolean(which("opencode")) || exists(paths.opencodeBin);
}
