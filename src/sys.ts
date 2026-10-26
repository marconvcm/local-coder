// Process, filesystem and network helpers (Node APIs, so they run under Bun and Node).

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  /** Share the terminal with the child (progress bars, sudo prompts). */
  inherit?: boolean;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

export function run(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let child;
    try {
      child = spawn(cmd, args, {
        stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...opts.env },
      });
    } catch (e) {
      return finish({ code: 127, out: "", err: String(e) });
    }

    let out = "";
    let err = "";
    if (!opts.inherit) {
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (err += d));
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input ?? "");
    }

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish({ code: 124, out: out.trim(), err: "timed out" });
        }, opts.timeoutMs)
      : undefined;

    child.on("error", (e) => finish({ code: 127, out: out.trim(), err: err.trim() || String(e) }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      finish({ code: code ?? 1, out: out.trim(), err: err.trim() });
    });
  });
}

/** Run a shell pipeline (used for the official `curl | sh` installers). */
export const shell = (script: string, opts: RunOptions = {}) => run("sh", ["-c", script], opts);

export function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export const exists = (path: string) => existsSync(path);

export const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

/** Prefix for commands that need root. */
export const sudo = (args: string[]): [string, string[]] =>
  isRoot() ? [args[0]!, args.slice(1)] : ["sudo", args];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP status for a URL, or 0 when the host is unreachable. */
export async function httpStatus(
  url: string,
  init: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<number> {
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

/** Registry status for an Ollama tag: 200 exists, 404 missing, 0 unreachable. */
export function registryStatus(tag: string): Promise<number> {
  const [name = "", version = "latest"] = tag.split(":");
  const repo = name.includes("/") ? name : `library/${name}`;
  return httpStatus(`https://registry.ollama.ai/v2/${repo}/manifests/${version}`, {
    headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
  });
}

/** Free space in GB on the filesystem that holds `path` (walks up to an existing parent). */
export async function freeGB(path: string): Promise<number | undefined> {
  let dir = path;
  while (!existsSync(dir) && dir !== "/") dir = join(dir, "..");
  const r = await run("df", ["-Pk", dir]);
  const fields = r.out.split("\n")[1]?.trim().split(/\s+/);
  const kb = Number(fields?.[3]);
  return Number.isFinite(kb) ? Math.floor(kb / 1024 / 1024) : undefined;
}

/** Whether a TCP port has a listener: true / false / undefined (unknown). */
export async function portInUse(port: number): Promise<boolean | undefined> {
  if (which("lsof")) {
    const r = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    return r.code === 0 && r.out.length > 0;
  }
  if (which("ss")) {
    const r = await run("ss", ["-ltnH", `sport = :${port}`]);
    return r.out.length > 0;
  }
  return undefined;
}
