// Installer: Ollama + service, model pull, OpenCode + config, warm-up.

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { candidateTags } from "./catalog";
import { ollamaUp } from "./doctor";
import type { Platform } from "./platform";
import {
  MARKER,
  type Settings,
  clientEnv,
  hasSystemd,
  ollamaUrl,
  opencodeInstalled,
  paths,
  serverEnv,
} from "./settings";
import { exists, isRoot, run, shell, sleep, sudo, which } from "./sys";
import { log } from "./ui";

export interface InstallResult {
  tag: string;
  service: string;
  logs: string;
  stop: string;
  start: string;
}

class InstallError extends Error {}
const die = (msg: string): never => {
  throw new InstallError(msg);
};

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function ensureOllama(p: Platform): Promise<string> {
  log.step("Ollama");
  if (p.os === "macos") {
    if (!which("brew")) die("Homebrew not found. Install it from https://brew.sh");
    if ((await run("brew", ["list", "ollama"])).code === 0) {
      await run("brew", ["upgrade", "ollama"]);
      log.ok("Ollama already installed (upgraded if needed)");
    } else {
      log.info("Installing with Homebrew…");
      if ((await run("brew", ["install", "ollama"], { inherit: true })).code !== 0) die("brew install ollama failed");
      log.ok("Ollama installed");
    }
    const prefix = (await run("brew", ["--prefix"])).out;
    return join(prefix, "bin", "ollama");
  }

  if (!which("ollama")) {
    log.info("Running the official installer (may ask for your sudo password)…");
    const r = await shell("curl -fsSL https://ollama.com/install.sh | sh", { inherit: true });
    if (r.code !== 0 || !which("ollama")) die("The Ollama installer failed");
    log.ok("Ollama installed");
  } else {
    log.ok("Ollama already installed");
  }
  return which("ollama")!;
}

interface Service {
  kind: string;
  logs: string;
  stop: string;
  start: string;
}

async function stopOtherOllamas(p: Platform) {
  if (p.os === "macos") {
    await run("brew", ["services", "stop", "ollama"]);
    await run("osascript", ["-e", 'quit app "Ollama"']);
  }
  await run("pkill", ["-f", "ollama serve"]);
  await sleep(1000);
}

async function launchAgent(bin: string, s: Settings): Promise<Service> {
  const env = Object.entries(serverEnv(s))
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${paths.launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${paths.macLog}</string>
  <key>StandardErrorPath</key>
  <string>${paths.macLog}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(paths.launchAgent), { recursive: true });
  mkdirSync(dirname(paths.macLog), { recursive: true });
  writeFileSync(paths.launchAgent, plist);

  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run("launchctl", ["bootout", `${domain}/${paths.launchAgentLabel}`]);
  const r = await run("launchctl", ["bootstrap", domain, paths.launchAgent]);
  if (r.code !== 0) die(`launchctl bootstrap failed: ${r.err}`);

  return {
    kind: "launchd (LaunchAgent)",
    logs: `tail -f ${paths.macLog}`,
    stop: `launchctl bootout gui/$(id -u)/${paths.launchAgentLabel}`,
    start: `launchctl bootstrap gui/$(id -u) ${paths.launchAgent}`,
  };
}

async function systemDropin(s: Settings): Promise<Service> {
  const body = [`# ${MARKER}`, "[Service]", ...Object.entries(serverEnv(s)).map(([k, v]) => `Environment="${k}=${v}"`), ""].join("\n");
  const tmp = join(os.tmpdir(), `ollama-override-${process.pid}.conf`);
  writeFileSync(tmp, body);
  if (!isRoot()) log.info("Writing the systemd override (may ask for your sudo password)…");
  const steps: string[][] = [
    ["mkdir", "-p", dirname(paths.systemdDropin)],
    ["install", "-m", "0644", tmp, paths.systemdDropin],
    ["systemctl", "daemon-reload"],
    ["systemctl", "enable", "ollama"],
    ["systemctl", "restart", "ollama"],
  ];
  for (const step of steps) {
    const [cmd, args] = sudo(step);
    const r = await run(cmd, args, { inherit: true });
    if (r.code !== 0) die(`Failed: ${step.join(" ")}`);
  }
  return {
    kind: "systemd (system service)",
    logs: "journalctl -u ollama -f",
    stop: "sudo systemctl stop ollama",
    start: "sudo systemctl start ollama",
  };
}

async function userUnit(bin: string, s: Settings): Promise<Service> {
  const unit = [
    `# ${MARKER}`,
    "[Unit]",
    "Description=Ollama (local model server)",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${bin} serve`,
    ...Object.entries(serverEnv(s)).map(([k, v]) => `Environment="${k}=${v}"`),
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  mkdirSync(dirname(paths.userUnit), { recursive: true });
  writeFileSync(paths.userUnit, unit);
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "ollama"]);
  const r = await run("systemctl", ["--user", "restart", "ollama"]);
  if (r.code !== 0) die(`systemctl --user restart ollama failed: ${r.err}`);

  // Keep running after logout
  const user = os.userInfo().username;
  if ((await run("loginctl", ["enable-linger", user])).code !== 0) {
    const [cmd, args] = sudo(["loginctl", "enable-linger", user]);
    if ((await run(cmd, args, { inherit: true })).code !== 0) {
      log.warn("Couldn't enable lingering: Ollama will stop when you log out.");
    }
  }
  return {
    kind: "systemd (user service)",
    logs: "journalctl --user -u ollama -f",
    stop: "systemctl --user stop ollama",
    start: "systemctl --user start ollama",
  };
}

function backgroundProcess(bin: string, s: Settings): Service {
  mkdirSync(dirname(paths.plainLog), { recursive: true });
  const fd = openSync(paths.plainLog, "a");
  const child = spawn(bin, ["serve"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...serverEnv(s) },
  });
  child.unref();
  log.warn("systemd not available: Ollama started as a background process.\nIt won't restart after a reboot; run this tool again to start it.");
  const env = Object.entries(serverEnv(s)).map(([k, v]) => `${k}=${v}`).join(" ");
  return {
    kind: "background process",
    logs: `tail -f ${paths.plainLog}`,
    stop: "pkill -f 'ollama serve'",
    start: `env ${env} nohup ${bin} serve >>${paths.plainLog} 2>&1 &`,
  };
}

async function configureService(p: Platform, bin: string, s: Settings): Promise<Service> {
  log.step("Ollama service");
  await stopOtherOllamas(p);
  let svc: Service;
  if (p.os === "macos") svc = await launchAgent(bin, s);
  else if (hasSystemd() && (await run("systemctl", ["cat", "ollama.service"])).code === 0) svc = await systemDropin(s);
  else if (hasSystemd()) svc = await userUnit(bin, s);
  else svc = backgroundProcess(bin, s);

  for (let i = 0; i < 45 && !(await ollamaUp(s)); i++) await sleep(1000);
  if (!(await ollamaUp(s))) die(`Ollama didn't start. Check the logs: ${svc.logs}`);
  log.ok(`Running via ${svc.kind} on ${s.listen}:${s.port} · context ${s.context} · model kept in memory`);
  if (s.listen === "0.0.0.0") log.warn("Ollama is reachable from your network with no authentication.");
  return svc;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

async function pullModel(p: Platform, bin: string, s: Settings, preferred?: string): Promise<string> {
  log.step("Model");
  const tags = [...new Set([preferred, ...candidateTags(s.entry, p)].filter((t): t is string => Boolean(t)))];
  const env = clientEnv(s);
  let signedIn = false;

  for (const tag of tags) {
    log.info(s.entry.kind === "cloud" ? `Linking ${tag} (cloud, nothing big to download)…` : `Downloading ${tag}${s.entry.sizeGB ? ` (~${s.entry.sizeGB} GB)` : ""}…`);
    let r = await run(bin, ["pull", tag], { inherit: true, env });
    if (r.code !== 0 && s.entry.kind === "cloud" && !signedIn) {
      log.info("Cloud models need an ollama.com account. Starting `ollama signin`…");
      await run(bin, ["signin"], { inherit: true, env });
      signedIn = true;
      r = await run(bin, ["pull", tag], { inherit: true, env });
    }
    if (r.code === 0) {
      log.ok(`Model ready: ${tag}`);
      return tag;
    }
    log.warn(`Couldn't pull ${tag}`);
  }
  return die(`Couldn't pull any of: ${tags.join(", ")}`);
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

async function ensureOpenCode() {
  log.step("OpenCode");
  if (opencodeInstalled()) {
    log.ok("OpenCode already installed");
    return;
  }
  log.info("Running the official installer…");
  const r = await shell("curl -fsSL https://opencode.ai/install | bash", { inherit: true });
  if (r.code !== 0) die("The OpenCode installer failed");
  log.ok(opencodeInstalled() ? "OpenCode installed" : "OpenCode installed; open a new terminal to get it on your PATH");
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export function writeOpenCodeConfig(s: Settings, tag: string) {
  const file = paths.opencodeConfig;
  let cfg: Json = {};
  if (exists(file)) {
    const backup = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
    try {
      cfg = obj(JSON.parse(readFileSync(file, "utf8")));
      log.info(`Merging into your existing config (backup: ${backup})`);
    } catch {
      log.warn(`Existing config isn't plain JSON; replacing it (backup: ${backup})`);
    }
  }

  const providers = obj(cfg.provider);
  const ollama = obj(providers.ollama);
  const models = obj(ollama.models);
  models[tag] = {
    name: s.entry.kind === "cloud" ? s.entry.label : `${s.entry.label} (local)`,
    ...(s.entry.kind === "local" ? { limit: { context: s.context, output: 16_384 } } : {}),
  };
  providers.ollama = {
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama",
    ...ollama,
    options: { ...obj(ollama.options), baseURL: `${ollamaUrl(s)}/v1` },
    models,
  };
  cfg = { $schema: "https://opencode.ai/config.json", ...cfg, provider: providers, model: `ollama/${tag}` };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  log.ok(`OpenCode now uses ollama/${tag} by default (${file})`);
}

// ---------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------

async function warmUp(s: Settings, tag: string) {
  log.step("Warm-up");
  log.info("Loading the model (the first load can take a minute or two)…");
  const started = Date.now();
  try {
    const res = await fetch(`${ollamaUrl(s)}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag, prompt: "Reply with the single word OK.", stream: false }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    log.ok(`Model answered in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    log.warn(`Warm-up failed (${e instanceof Error ? e.message : e}). Try: ollama run ${tag}`);
  }
}

// ---------------------------------------------------------------------------

export async function install(p: Platform, s: Settings, preferredTag?: string): Promise<InstallResult> {
  const bin = await ensureOllama(p);
  const svc = await configureService(p, bin, s);
  const tag = await pullModel(p, bin, s, preferredTag);
  await ensureOpenCode();
  log.step("OpenCode config");
  writeOpenCodeConfig(s, tag);
  await warmUp(s, tag);
  return { tag, service: svc.kind, logs: svc.logs, stop: svc.stop, start: svc.start };
}

export { InstallError };
