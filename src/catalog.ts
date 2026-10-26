// Models this tool knows how to set up. Tags are Ollama library tags.
//
// Local models download weights to this machine. Cloud models run on Ollama
// Cloud through the same local API (needs `ollama signin`; your code leaves the
// machine). Tags that may not exist yet are verified live against the Ollama
// registry before anything is installed.

import { c } from "./ui";
import { type Fit, type Hardware, type Platform, fitFor } from "./platform";
import { registryStatus } from "./sys";

export type Family = "Qwen" | "DeepSeek" | "Kimi" | "Gemma" | "Custom";
export type Kind = "local" | "cloud";

export interface ModelEntry {
  id: string;
  family: Family;
  label: string;
  kind: Kind;
  /** Tags to try in order; the first that exists in the registry wins. */
  tags: string[];
  /** Preferred tags on Apple Silicon (MLX builds), tried before `tags`. */
  macTags?: string[];
  /** Approximate download / weights size in GB (local models). */
  sizeGB?: number;
  notes: string;
  recommended?: boolean;
  /** Good at agentic tool calling (OpenCode agents depend on it). */
  agentic: boolean;
}

export const CATALOG: ModelEntry[] = [
  // --- Qwen ----------------------------------------------------------------
  {
    id: "qwen3.8-27b",
    family: "Qwen",
    label: "Qwen3.8 27B",
    kind: "local",
    tags: ["qwen3.8:27b"],
    macTags: ["qwen3.8:27b-mlx"],
    sizeGB: 18,
    notes: "Best local coding model for one GPU or a 32 GB Mac. Dense, Apache 2.0, verbose thinker.",
    recommended: true,
    agentic: true,
  },
  {
    id: "qwen3.6-35b-a3b",
    family: "Qwen",
    label: "Qwen3.6 35B-A3B (MoE)",
    kind: "local",
    tags: ["qwen3.6:35b-a3b"],
    sizeGB: 23,
    notes: "MoE with 3B active params: fast on low-bandwidth machines (mini PCs, iGPUs).",
    agentic: true,
  },
  {
    id: "qwen3-coder-30b",
    family: "Qwen",
    label: "Qwen3-Coder 30B-A3B (MoE)",
    kind: "local",
    tags: ["qwen3-coder:30b"],
    sizeGB: 19,
    notes: "Coding specialist MoE, fast, no thinking mode. Older generation.",
    agentic: true,
  },
  // --- Gemma ---------------------------------------------------------------
  {
    id: "gemma4-12b",
    family: "Gemma",
    label: "Gemma 4 12B",
    kind: "local",
    tags: ["gemma4:12b"],
    sizeGB: 8,
    notes: "Small and quick. For 8–16 GB machines or as a helper model.",
    agentic: true,
  },
  // --- DeepSeek ------------------------------------------------------------
  {
    id: "deepseek-r1-32b",
    family: "DeepSeek",
    label: "DeepSeek-R1 32B (distill)",
    kind: "local",
    tags: ["deepseek-r1:32b"],
    sizeGB: 20,
    notes: "R1 reasoning distilled into Qwen. Good at reasoning, weaker at agent tool calls.",
    agentic: false,
  },
  {
    id: "deepseek-r1-14b",
    family: "DeepSeek",
    label: "DeepSeek-R1 14B (distill)",
    kind: "local",
    tags: ["deepseek-r1:14b"],
    sizeGB: 9,
    notes: "Mid-size R1 distill. Chat and reasoning more than agentic coding.",
    agentic: false,
  },
  {
    id: "deepseek-r1-8b",
    family: "DeepSeek",
    label: "DeepSeek-R1 8B (distill)",
    kind: "local",
    tags: ["deepseek-r1:8b"],
    sizeGB: 5,
    notes: "Runs on almost anything, including 8 GB GPUs.",
    agentic: false,
  },
  {
    id: "deepseek-v4-flash-cloud",
    family: "DeepSeek",
    label: "DeepSeek V4 Flash (cloud)",
    kind: "cloud",
    tags: ["deepseek-v4-flash:cloud"],
    notes: "The real DeepSeek V4 (284B) on Ollama Cloud. Needs `ollama signin`; code leaves this machine.",
    agentic: true,
  },
  {
    id: "deepseek-v4-pro-cloud",
    family: "DeepSeek",
    label: "DeepSeek V4 Pro (cloud)",
    kind: "cloud",
    tags: ["deepseek-v4-pro:cloud"],
    notes: "DeepSeek's flagship (1.6T) on Ollama Cloud. Heavier usage tier.",
    agentic: true,
  },
  // --- Kimi ----------------------------------------------------------------
  {
    id: "kimi-cloud",
    family: "Kimi",
    label: "Kimi (cloud, checked live)",
    kind: "cloud",
    tags: ["kimi-k3:cloud", "kimi-k2.7-code:cloud"],
    notes: "Kimi K3 is ~1.5 TB, so it can't run locally. Uses Ollama Cloud if a Kimi tag is published there.",
    agentic: true,
  },
];

export function customEntry(tag: string): ModelEntry {
  const cloud = /(^|[:-])cloud$/.test(tag);
  return {
    id: "custom",
    family: "Custom",
    label: tag,
    kind: cloud ? "cloud" : "local",
    tags: [tag],
    notes: "Custom Ollama tag.",
    agentic: true,
  };
}

/** Find a catalog entry by id or tag; anything else is treated as a custom tag. */
export function findEntry(query: string): ModelEntry {
  return (
    CATALOG.find((m) => m.id === query || m.tags.includes(query) || m.macTags?.includes(query)) ??
    customEntry(query)
  );
}

export function candidateTags(entry: ModelEntry, p: Platform): string[] {
  const tags = p.os === "macos" ? [...(entry.macTags ?? []), ...entry.tags] : entry.tags;
  return [...new Set(tags)];
}

export interface Resolution {
  tag?: string; // first tag confirmed in the registry
  checked: { tag: string; status: number }[];
  offline: boolean; // registry unreachable: could not verify
}

export async function resolveTag(entry: ModelEntry, p: Platform): Promise<Resolution> {
  const checked: Resolution["checked"] = [];
  for (const tag of candidateTags(entry, p)) {
    const status = await registryStatus(tag);
    checked.push({ tag, status });
    if (status === 200) return { tag, checked, offline: false };
    if (status === 0) return { checked, offline: true };
  }
  return { checked, offline: false };
}

/** Default pick: the recommended model if it fits, else the best local model that fits. */
export function defaultEntry(hw: Hardware): ModelEntry {
  const ok = (f: Fit) => f === "fits" || f === "tight";
  return (
    CATALOG.find((m) => m.recommended && ok(fitFor(m.sizeGB, hw))) ??
    CATALOG.find((m) => m.kind === "local" && m.agentic && ok(fitFor(m.sizeGB, hw))) ??
    CATALOG.find((m) => m.kind === "local" && ok(fitFor(m.sizeGB, hw))) ??
    CATALOG[0]!
  );
}

export function fitBadge(fit: Fit): string {
  switch (fit) {
    case "fits":
      return c.green("● fits");
    case "tight":
      return c.yellow("● tight");
    case "slow":
      return c.yellow("● slow");
    case "too-big":
      return c.red("● too big");
    case "cloud":
      return c.blue("☁ cloud");
  }
}
