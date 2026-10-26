// Doctor: inspects the machine and reports whether the install can proceed.
// It never changes anything.

import { readFileSync } from "node:fs";
import { type ModelEntry, resolveTag } from "./catalog";
import { type Hardware, type Platform, fitFor, fitLabel } from "./platform";
import {
  MARKER,
  type Settings,
  REQUIRED_DISK_MARGIN_GB,
  hasSystemd,
  modelsDir,
  ollamaUrl,
  opencodeInstalled,
  paths,
} from "./settings";
import { exists, freeGB, httpStatus, isRoot, portInUse, run, which } from "./sys";
import { c, sym } from "./ui";

export type Level = "ok" | "warn" | "fail" | "info";

export interface Check {
  level: Level;
  text: string;
  hint?: string;
}

export interface Section {
  title: string;
  checks: Check[];
}

export interface DoctorReport {
  sections: Section[];
  /** Tag confirmed in the registry (or the first candidate when offline). */
  tag?: string;
  counts: Record<"ok" | "warn" | "fail", number>;
}

export async function ollamaUp(s: Settings): Promise<boolean> {
  return (await httpStatus(`${ollamaUrl(s)}/api/version`, { timeoutMs: 3000 })) === 200;
}

export async function pulledModels(s: Settings): Promise<string[]> {
  try {
    const res = await fetch(`${ollamaUrl(s)}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function runDoctor(p: Platform, hw: Hardware, s: Settings): Promise<DoctorReport> {
  const sections: Section[] = [];
  const section = (title: string) => {
    const sec: Section = { title, checks: [] };
    sections.push(sec);
    return (level: Level, text: string, hint?: string) => sec.checks.push({ level, text, hint });
  };
  const entry: ModelEntry = s.entry;
  const ollamaInstalled = Boolean(which("ollama"));
  const systemUnit = p.os === "linux" && hasSystemd() && (await run("systemctl", ["cat", "ollama.service"])).code === 0;

  // --- Tools ---------------------------------------------------------------
  const tools = section("Required tools");
  if (which("curl")) tools("ok", "curl found");
  else tools("fail", "curl not found", "Install curl with your package manager.");

  if (p.os === "macos") {
    if (which("brew")) tools("ok", "Homebrew found");
    else tools("fail", "Homebrew not found", "Install it from https://brew.sh");
  } else {
    if (isRoot()) tools("ok", "Running as root");
    else if (which("sudo")) {
      const passwordless = (await run("sudo", ["-n", "true"])).code === 0;
      tools("ok", `sudo available${passwordless ? " (no password needed)" : " (you will be asked for your password)"}`);
    } else if (ollamaInstalled) {
      tools("warn", "sudo not found", "The system service can't be configured; a user service will be used instead.");
    } else {
      tools("fail", "sudo not found and not running as root", "The Ollama installer needs root.");
    }
    if (hasSystemd()) tools("ok", "systemd available");
    else tools("warn", "systemd not available", "Ollama will run as a plain background process and won't start on boot.");
  }

  // --- Hardware ------------------------------------------------------------
  const hwc = section("Hardware");
  if (hw.gpu === "nvidia-no-driver") {
    hwc("warn", "NVIDIA GPU found but the driver isn't working", "Install the NVIDIA driver first, or Ollama will use the CPU.");
  } else if (hw.gpu === "none") {
    hwc("warn", "No GPU detected", "Ollama will run on the CPU; expect slow responses.");
  } else {
    hwc("ok", `${hw.gpuName} · ${hw.gpuMemEstimated ? "~" : ""}${hw.gpuMemGB} GB usable for models`);
  }
  if (entry.kind === "local") {
    const fit = fitFor(entry.sizeGB, hw);
    const size = entry.sizeGB ? ` (~${entry.sizeGB} GB)` : "";
    const msg = `${entry.label}${size}: ${fitLabel[fit]}`;
    if (entry.sizeGB === undefined) hwc("info", `${entry.label}: size unknown, can't estimate the fit`);
    else if (fit === "fits") hwc("ok", msg);
    else if (fit === "tight") hwc("warn", msg, "Consider a smaller context (--context 32768) or a smaller model.");
    else if (fit === "slow") hwc("warn", msg, "Part of the model will run on the CPU. A MoE model (e.g. qwen3.6-35b-a3b) is much faster here.");
    else hwc("fail", msg, "Pick a smaller model (see --list).");
  } else {
    hwc("info", `${entry.label} runs on Ollama Cloud; local hardware doesn't matter`);
  }

  // --- Model ---------------------------------------------------------------
  const mc = section("Model");
  const res = await resolveTag(entry, p);
  let tag = res.tag;
  if (res.tag) {
    mc("ok", `${res.tag} is available in the Ollama registry`);
    const skipped = res.checked.filter((r) => r.tag !== res.tag).map((r) => r.tag);
    if (skipped.length) mc("info", `Not published: ${skipped.join(", ")}`);
  } else if (res.offline) {
    tag = res.checked[0]?.tag;
    mc("fail", "Can't reach registry.ollama.ai", "The model download needs it. Check your connection or proxy.");
  } else if (entry.family === "Kimi") {
    mc(
      "fail",
      "No Kimi model is published on Ollama right now",
      `Checked: ${res.checked.map((r) => r.tag).join(", ")}. Kimi K3 is too large to run locally; pick another model or a custom tag.`,
    );
  } else {
    mc("fail", `${res.checked.map((r) => r.tag).join(", ")} not found in the Ollama registry`, "Check the tag on ollama.com/search.");
  }
  if (!entry.agentic) {
    mc("warn", "Weak at agentic tool calling", "OpenCode agents may stall or misuse tools. Fine for chat and reasoning.");
  }
  if (entry.kind === "cloud") {
    mc("warn", "Cloud model: your prompts and code are sent to Ollama Cloud", "You'll be asked to run `ollama signin` (ollama.com account).");
  }

  // --- Disk ----------------------------------------------------------------
  if (entry.kind === "local") {
    const dc = section("Disk space");
    const dir = modelsDir(p, systemUnit);
    const free = await freeGB(dir);
    const need = (entry.sizeGB ?? 20) + REQUIRED_DISK_MARGIN_GB;
    if (free === undefined) dc("warn", `Couldn't check free space at ${dir}`);
    else if (free >= need) dc("ok", `${free} GB free for models (${dir})`);
    else dc("fail", `Only ${free} GB free at ${dir}; about ${need} GB needed`);
  }

  // --- Network -------------------------------------------------------------
  const nc = section("Network");
  if (p.os === "linux" && !ollamaInstalled) {
    const st = await httpStatus("https://ollama.com/install.sh", { method: "HEAD" });
    if (st) nc("ok", "ollama.com reachable (installer)");
    else nc("fail", "Can't reach ollama.com", "Needed to download the Ollama installer.");
  }
  if (!res.offline) nc("ok", "registry.ollama.ai reachable (model download)");
  if (!opencodeInstalled()) {
    const st = await httpStatus("https://opencode.ai/install", { method: "HEAD" });
    if (st) nc("ok", "opencode.ai reachable (installer)");
    else nc("fail", "Can't reach opencode.ai", "Needed to download the OpenCode installer.");
  }

  // --- Current installation ------------------------------------------------
  const cc = section("Current installation");
  if (ollamaInstalled) {
    const v = (await run("ollama", ["--version"])).out.match(/\d+\.\d+(\.\d+)?/)?.[0];
    cc("ok", `Ollama installed${v ? ` (${v})` : ""}`);
  } else {
    cc("info", "Ollama not installed yet (will be installed)");
  }

  if (await ollamaUp(s)) {
    cc("ok", `Ollama running on port ${s.port} (will be restarted with the new settings)`);
    if (tag && (await pulledModels(s)).includes(tag)) cc("ok", `${tag} already downloaded`);
  } else {
    const used = await portInUse(s.port);
    if (used === true) cc("fail", `Port ${s.port} is used by another program`, "Free it or use --port.");
    else if (used === false) cc("ok", `Port ${s.port} is free`);
    else cc("warn", `Couldn't check port ${s.port} (no lsof or ss)`);
  }

  if (p.os === "macos") {
    if ((await run("pgrep", ["-x", "Ollama"])).code === 0) {
      cc("info", "The Ollama desktop app is running; it will be quit and replaced by a LaunchAgent");
    }
    if ((await run("brew", ["services", "list"])).out.split("\n").some((l) => /^ollama\s+started/.test(l))) {
      cc("info", "The Ollama brew service is running; it will be stopped and replaced by a LaunchAgent");
    }
  } else if (exists(paths.systemdDropin)) {
    let mine = false;
    try {
      mine = readFileSync(paths.systemdDropin, "utf8").includes(MARKER);
    } catch {
      /* unreadable */
    }
    if (!mine) cc("warn", `${paths.systemdDropin} exists and wasn't created by this tool`, "It will be overwritten.");
  }

  if (opencodeInstalled()) cc("ok", "OpenCode installed");
  else cc("info", "OpenCode not installed yet (will be installed)");

  if (exists(paths.opencodeConfig)) {
    try {
      JSON.parse(readFileSync(paths.opencodeConfig, "utf8"));
      cc("info", `${paths.opencodeConfig} exists; the model will be merged in (backup kept)`);
    } catch {
      cc("warn", `${paths.opencodeConfig} isn't plain JSON (comments?)`, "It will be backed up and replaced.");
    }
  }

  if (s.listen === "0.0.0.0") {
    cc("warn", "Ollama will be reachable from your network with no authentication", "Keep it behind your firewall.");
  }

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const sec of sections) for (const ch of sec.checks) if (ch.level !== "info") counts[ch.level]++;
  return { sections, tag, counts };
}

const icon: Record<Level, string> = { ok: sym.ok, warn: sym.warn, fail: sym.fail, info: sym.info };

export function printReport(report: DoctorReport) {
  for (const sec of report.sections) {
    console.log();
    console.log(`${sym.step} ${c.bold(sec.title)}`);
    for (const ch of sec.checks) {
      const text = ch.level === "fail" ? c.red(ch.text) : ch.level === "warn" ? c.yellow(ch.text) : ch.text;
      console.log(`${sym.bar} ${icon[ch.level]} ${text}`);
      if (ch.hint) console.log(`${sym.bar}   ${c.gray(ch.hint)}`);
    }
  }
  const { ok, warn, fail } = report.counts;
  console.log();
  console.log(`${c.bold("Summary:")} ${c.green(`${ok} passed`)}, ${c.yellow(`${warn} warning(s)`)}, ${c.red(`${fail} problem(s)`)}`);
  if (fail > 0) console.log(c.red("Not ready. Fix the items marked ✗ and run the doctor again."));
  else if (warn > 0) console.log(c.yellow("Ready, with warnings. Review the items marked ! before installing."));
  else console.log(c.green("Ready to install."));
}
