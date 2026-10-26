#!/usr/bin/env bun
// local-coder: set up a local coding agent (Ollama + a coding model + OpenCode)
// on macOS (Apple Silicon) and Linux (x86_64 / arm64).

import { parseArgs } from "node:util";
import { CATALOG, type ModelEntry, customEntry, defaultEntry, findEntry, fitBadge } from "./catalog";
import { printReport, runDoctor } from "./doctor";
import { InstallError, install } from "./install";
import { type Hardware, type Platform, describeHardware, detectHardware, detectPlatform, fitFor, fitLabel } from "./platform";
import { DEFAULTS, type Settings } from "./settings";
import { banner, box, c, confirm, isTTY, log, padVisible, select, spinner, sym, text } from "./ui";

const VERSION = "0.1.0";

const HELP = `
${c.bold("local-coder")} ${c.gray(`v${VERSION}`)}
Set up a local coding agent: Ollama + a coding model + OpenCode.
Works on macOS (Apple Silicon) and Linux (x86_64, arm64).

${c.bold("Usage")}
  local-coder                       interactive setup (TUI)
  local-coder --doctor [-m MODEL]   check that this machine is ready (changes nothing)
  local-coder --list                list the models and how they fit this machine
  local-coder -m MODEL --yes        install without prompts

${c.bold("Options")}
  -m, --model <id|tag>   catalog id (see --list) or any Ollama tag
      --context <n>      context window in tokens       (default ${DEFAULTS.context})
      --port <n>         port for Ollama                (default ${DEFAULTS.port})
      --listen <addr>    127.0.0.1 or 0.0.0.0           (default ${DEFAULTS.listen})
  -y, --yes              don't ask, install right away
  -h, --help             show this help
  -v, --version          show the version
`;

function fail(message: string): never {
  console.error(`${sym.fail} ${message}`);
  process.exit(1);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        doctor: { type: "boolean" },
        list: { type: "boolean" },
        model: { type: "string", short: "m" },
        context: { type: "string" },
        port: { type: "string" },
        listen: { type: "string" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    fail(`${e instanceof Error ? e.message : e}\nRun with --help for usage.`);
  }
}

function toInt(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer between ${min} and ${max}`);
  return n;
}

function platformOrDie(): Platform {
  const { platform, error } = detectPlatform();
  if (!platform) fail(error!);
  return platform;
}

// ---------------------------------------------------------------------------
// Non-interactive commands
// ---------------------------------------------------------------------------

function printList(hw: Hardware) {
  console.log();
  console.log(c.bold("Models") + c.gray(`  (fit for this machine: ~${hw.gpuMemGB} GB usable for models, ${hw.ramGB} GB RAM)`));
  let family = "";
  for (const m of CATALOG) {
    if (m.family !== family) {
      family = m.family;
      console.log();
      console.log(c.cyan(family));
    }
    const size = m.sizeGB ? `${m.sizeGB} GB` : "—";
    const star = m.recommended ? c.yellow(" ★") : "";
    console.log(
      `  ${m.id.padEnd(26)} ${padVisible(fitBadge(fitFor(m.sizeGB, hw)), 11)} ${size.padStart(6)}  ${m.label}${star}`,
    );
    console.log(`  ${" ".repeat(26)} ${c.gray(m.notes)}`);
  }
  console.log();
  console.log(c.gray("Any other Ollama tag works too: local-coder -m <tag>"));
}

function finalBox(r: { tag: string; service: string; logs: string; stop: string; start: string }) {
  box("Done", [
    `${c.green("Model")}      ${r.tag}`,
    `${c.green("Service")}    ${r.service}`,
    "",
    `${c.bold("Start coding")}   cd /path/to/repo && opencode`,
    `${c.bold("Loaded models")}  ollama ps`,
    `${c.bold("Server logs")}    ${r.logs}`,
    `${c.bold("Stop server")}    ${r.stop}`,
    `${c.bold("Start server")}   ${r.start}`,
    `${c.bold("Check setup")}    local-coder --doctor -m ${r.tag}`,
  ]);
}

async function runInstall(p: Platform, s: Settings, tag?: string) {
  try {
    const result = await install(p, s, tag);
    finalBox(result);
  } catch (e) {
    if (e instanceof InstallError) fail(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Interactive TUI
// ---------------------------------------------------------------------------

async function pickModel(hw: Hardware): Promise<ModelEntry> {
  const def = defaultEntry(hw);
  const options = CATALOG.map((m) => {
    const fit = fitFor(m.sizeGB, hw);
    const size = m.sizeGB ? c.gray(` ${m.sizeGB} GB`) : "";
    const star = m.id === def.id ? c.yellow(" ★ suggested") : "";
    return {
      value: m.id,
      label: `${c.gray(m.family.padEnd(9))}${padVisible(m.label + size, 38)} ${fitBadge(fit)}${star}`,
      hint: `${fitLabel[fit]} · ${m.notes}`,
    };
  });
  options.push({ value: "custom", label: `${c.gray("Other".padEnd(9))}Custom Ollama tag…`, hint: "Any tag from ollama.com/search" });

  const id = await select("Which model do you want to set up?", options, CATALOG.indexOf(def));
  if (id !== "custom") return CATALOG.find((m) => m.id === id)!;

  const tag = await text("Ollama tag", {
    placeholder: "e.g. qwen3.6:35b-a3b or gpt-oss:20b",
    validate: (v) => (/^[\w./-]+(:[\w.-]+)?$/.test(v) ? undefined : "That doesn't look like an Ollama tag"),
  });
  return customEntry(tag);
}

async function advanced(s: Settings): Promise<Settings> {
  const change = await confirm("Change advanced settings (context, port, network access)?", false);
  if (!change) return s;
  const context = Number(
    await text("Context window (tokens)", {
      placeholder: String(s.context),
      validate: (v) => (/^\d+$/.test(v) && Number(v) >= 2048 ? undefined : "Use a number ≥ 2048 (OpenCode wants ≥ 65536)"),
    }),
  );
  const port = Number(
    await text("Port for Ollama", {
      placeholder: String(s.port),
      validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : "Use a port between 1 and 65535"),
    }),
  );
  const listen = await select(
    "Who can use this Ollama server?",
    [
      { value: "127.0.0.1", label: "Only this computer", hint: "Safest. OpenCode on this machine only." },
      { value: "0.0.0.0", label: "Other machines on my network", hint: "No authentication: keep it behind your firewall." },
    ],
    s.listen === "0.0.0.0" ? 1 : 0,
  );
  return { ...s, context, port, listen };
}

async function doctorStep(p: Platform, hw: Hardware, s: Settings) {
  const sp = spinner("Running checks");
  const report = await runDoctor(p, hw, s);
  sp.stop("Checks finished");
  printReport(report);
  return report;
}

async function tui(p: Platform, base: Settings) {
  banner("local-coder", "local coding agent setup");

  const sp = spinner("Detecting hardware");
  const hw = await detectHardware(p);
  sp.stop("Hardware detected");
  box("This machine", describeHardware(p, hw));

  const action = await select("What do you want to do?", [
    { value: "setup", label: "Set up a coding model", hint: "Pick a model, check the machine, install everything" },
    { value: "doctor", label: "Run the doctor only", hint: "Check whether this machine is ready; changes nothing" },
    { value: "list", label: "List models", hint: "All models and how they fit this machine" },
    { value: "quit", label: "Quit" },
  ]);
  if (action === "quit") return;
  if (action === "list") return printList(hw);

  const entry = await pickModel(hw);
  if (entry.kind === "cloud") {
    box("Cloud model", [
      `${entry.label} runs on ${c.bold("Ollama Cloud")}, not on this machine.`,
      "Your prompts and code are sent to ollama.com.",
      "You'll need an ollama.com account (the installer runs `ollama signin`).",
    ]);
    if (!(await confirm("Continue with a cloud model?", true))) return;
  }

  const s = action === "setup" ? await advanced({ ...base, entry }) : { ...base, entry };
  const report = await doctorStep(p, hw, s);
  if (action === "doctor") return;

  if (report.counts.fail > 0) {
    console.log();
    log.fail("Fix the problems above, then run local-coder again.");
    process.exitCode = 1;
    return;
  }

  box("Ready to install", [
    `${c.bold("Model")}     ${report.tag ?? entry.tags[0]} ${c.gray(`(${entry.kind})`)}`,
    `${c.bold("Context")}   ${s.context} tokens`,
    `${c.bold("Server")}    ${s.listen}:${s.port}`,
    `${c.bold("Changes")}   Ollama service settings, ~/.config/opencode/opencode.json (backed up)`,
  ]);
  const go = await confirm(report.counts.warn > 0 ? "There are warnings. Install anyway?" : "Install now?", report.counts.warn === 0);
  if (!go) return;

  await runInstall(p, s, report.tag);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parse();
  if (values.help || positionals.includes("help")) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  const p = platformOrDie();
  const base: Settings = {
    entry: CATALOG[0]!,
    context: toInt("context", values.context, DEFAULTS.context, 2048, 1_048_576),
    port: toInt("port", values.port, DEFAULTS.port, 1, 65_535),
    listen: values.listen ?? DEFAULTS.listen,
  };
  if (!["127.0.0.1", "0.0.0.0", "localhost"].includes(base.listen)) {
    fail("--listen must be 127.0.0.1 (this machine) or 0.0.0.0 (your network)");
  }

  const doctor = values.doctor || positionals.includes("doctor");
  const list = values.list || positionals.includes("list");

  if (!doctor && !list && !values.yes) {
    if (!isTTY) fail("No terminal for the interactive setup. Use --yes, --doctor or --list (see --help).");
    return tui(p, base);
  }

  const hw = await detectHardware(p);
  const entry = values.model ? findEntry(values.model) : defaultEntry(hw);
  const s: Settings = { ...base, entry };

  if (list) return printList(hw);

  banner("local-coder", doctor ? "doctor (changes nothing)" : "install");
  box("This machine", describeHardware(p, hw));
  console.log(`${sym.info} Model: ${c.bold(entry.label)} ${c.gray(`(${entry.kind})`)}`);

  const report = await doctorStep(p, hw, s);
  if (doctor) {
    process.exitCode = report.counts.fail > 0 ? 1 : 0;
    return;
  }
  if (report.counts.fail > 0) fail("Not installing: fix the problems above first.");
  await runInstall(p, s, report.tag);
}

main().catch((e) => {
  console.error(`${sym.fail} Unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exit(1);
});
