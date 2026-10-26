// Platform and hardware detection, and how well a model fits this machine.

import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { exists, run, which } from "./sys";

export type OSName = "macos" | "linux";
export type Arch = "x86_64" | "arm64";

export interface Platform {
  os: OSName;
  arch: Arch;
}

export function detectPlatform(): { platform?: Platform; error?: string } {
  const osName = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!osName) return { error: `Unsupported OS: ${process.platform}. Only macOS and Linux are supported.` };
  if (!arch) return { error: `Unsupported architecture: ${process.arch}. Only x86_64 and arm64 are supported.` };
  if (osName === "macos" && arch !== "arm64") return { error: "Intel Macs are not supported. Apple Silicon is required." };
  return { platform: { os: osName, arch } };
}

export type GpuKind = "apple" | "nvidia" | "nvidia-no-driver" | "amd" | "amd-integrated" | "none";

export interface Hardware {
  cpu: string;
  ramGB: number;
  gpu: GpuKind;
  gpuName?: string;
  /** Memory the model can live in on the GPU (unified memory share, VRAM, or VRAM+GTT). */
  gpuMemGB: number;
  gpuMemEstimated: boolean;
}

const GB = 1024 ** 3;

function readNumber(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

async function cpuName(p: Platform): Promise<string> {
  if (p.os === "macos") {
    const r = await run("sysctl", ["-n", "machdep.cpu.brand_string"]);
    if (r.code === 0 && r.out) return r.out;
  } else {
    try {
      const m = readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m);
      if (m?.[1]) return m[1].trim();
    } catch {
      /* fall through */
    }
  }
  return os.cpus()[0]?.model ?? "unknown CPU";
}

/** AMD GPUs via amdgpu sysfs: dedicated VRAM, or VRAM+GTT for integrated GPUs. */
function amdGpu(): { name: string; memGB: number; integrated: boolean } | undefined {
  let best: { name: string; memGB: number; integrated: boolean } | undefined;
  let cards: string[] = [];
  try {
    cards = readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d));
  } catch {
    return undefined;
  }
  for (const card of cards) {
    const dev = `/sys/class/drm/${card}/device`;
    let vendor = "";
    try {
      vendor = readFileSync(`${dev}/vendor`, "utf8").trim();
    } catch {
      continue;
    }
    if (vendor !== "0x1002") continue;
    const vram = readNumber(`${dev}/mem_info_vram_total`) ?? 0;
    const gtt = readNumber(`${dev}/mem_info_gtt_total`) ?? 0;
    const integrated = vram < 4 * GB;
    const memGB = Math.floor((integrated ? vram + gtt : vram) / GB);
    if (!best || memGB > best.memGB) {
      best = { name: integrated ? "AMD Radeon (integrated)" : "AMD Radeon", memGB, integrated };
    }
  }
  return best;
}

export async function detectHardware(p: Platform): Promise<Hardware> {
  const ramGB = Math.round(os.totalmem() / GB);
  const cpu = await cpuName(p);

  if (p.os === "macos") {
    const wired = Number((await run("sysctl", ["-n", "iogpu.wired_limit_mb"])).out);
    const custom = Number.isFinite(wired) && wired > 0;
    return {
      cpu,
      ramGB,
      gpu: "apple",
      gpuName: `${cpu} GPU`,
      gpuMemGB: custom ? Math.floor(wired / 1024) : Math.floor(ramGB * 0.75), // macOS default ~75%
      gpuMemEstimated: !custom,
    };
  }

  if (which("nvidia-smi")) {
    const r = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    const [name, mem] = (r.out.split("\n")[0] ?? "").split(",").map((s) => s.trim());
    if (r.code === 0 && name && mem) {
      return { cpu, ramGB, gpu: "nvidia", gpuName: name, gpuMemGB: Math.floor(Number(mem) / 1024), gpuMemEstimated: false };
    }
  }

  if (which("lspci")) {
    const r = await run("lspci");
    if (/(vga|3d)[^\n]*nvidia/i.test(r.out)) {
      return { cpu, ramGB, gpu: "nvidia-no-driver", gpuName: "NVIDIA (driver not working)", gpuMemGB: 0, gpuMemEstimated: true };
    }
  }

  const amd = amdGpu();
  if (amd) {
    return {
      cpu,
      ramGB,
      gpu: amd.integrated ? "amd-integrated" : "amd",
      gpuName: amd.name,
      gpuMemGB: amd.memGB,
      gpuMemEstimated: amd.integrated,
    };
  }
  if (exists("/dev/kfd")) {
    return { cpu, ramGB, gpu: "amd", gpuName: "AMD GPU", gpuMemGB: Math.floor(ramGB / 2), gpuMemEstimated: true };
  }

  return { cpu, ramGB, gpu: "none", gpuMemGB: 0, gpuMemEstimated: false };
}

export function describeHardware(p: Platform, hw: Hardware): string[] {
  const gpu =
    hw.gpu === "none"
      ? "none detected (CPU only)"
      : `${hw.gpuName ?? hw.gpu} · ${hw.gpuMemEstimated ? "~" : ""}${hw.gpuMemGB} GB usable for models`;
  return [`OS      ${p.os} / ${p.arch}`, `CPU     ${hw.cpu}`, `Memory  ${hw.ramGB} GB`, `GPU     ${gpu}`];
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

export type Fit = "cloud" | "fits" | "tight" | "slow" | "too-big";

/** Weights + ~20% for a long context window + 2 GB of runtime overhead. */
export function fitFor(sizeGB: number | undefined, hw: Hardware): Fit {
  if (sizeGB === undefined) return "cloud";
  const need = sizeGB * 1.2 + 2;
  if (hw.gpuMemGB >= need) return "fits";
  if (hw.gpuMemGB >= sizeGB + 0.5) return "tight";
  if (hw.ramGB * 0.85 >= sizeGB * 1.1 + 1) return "slow"; // CPU offload, short context
  return "too-big";
}

export const fitLabel: Record<Fit, string> = {
  cloud: "runs in Ollama Cloud",
  fits: "fits on this machine",
  tight: "fits, but little room for context",
  slow: "needs CPU offload (slow)",
  "too-big": "too big for this machine",
};
