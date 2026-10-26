// Compile local-coder into standalone binaries (no Bun or Node needed to run them).
//
//   bun run build                 all targets
//   bun run build linux-x64       one target

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64"];
const wanted = process.argv.slice(2);
const targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t)) : TARGETS;

mkdirSync("dist", { recursive: true });
let failed = 0;
for (const target of targets) {
  const out = `dist/local-coder-${target}`;
  const r = spawnSync(
    "bun",
    ["build", "src/index.ts", "--compile", "--minify", `--target=bun-${target}`, "--outfile", out],
    { stdio: "inherit" },
  );
  if (r.status === 0) console.log(`✓ ${out}`);
  else {
    console.error(`✗ ${target} failed`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
