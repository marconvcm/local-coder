# local-coder

Set up a local coding agent in one go: **Ollama** + a **coding model** + **OpenCode**,
on macOS (Apple Silicon) and Linux (x86_64 and arm64).

It detects your hardware, shows which models fit, checks the machine with a
doctor, then installs and wires everything together.

## Run it

```bash
bun run src/index.ts            # interactive TUI
bun run src/index.ts --doctor   # check the machine, change nothing
bun run src/index.ts --list     # models and how they fit this machine
bun run src/index.ts -m deepseek-r1-14b --yes   # no prompts
```

No dependencies to install: the TUI is built on Node APIs only, so Bun runs it as is.

## Standalone binaries

```bash
bun run build                   # dist/local-coder-{darwin-arm64,linux-x64,linux-arm64}
bun run build linux-x64         # one target
```

Bun cross-compiles, so you can build all three from your Mac and copy the Linux
binary to another machine. The binaries don't need Bun or Node.

## Models

| id | Ollama tag | Where | Notes |
|---|---|---|---|
| `qwen3.8-27b` ★ | `qwen3.8:27b` (`-mlx` on Mac) | local, ~18 GB | Best local coding model for one GPU or a 32 GB Mac |
| `qwen3.6-35b-a3b` | `qwen3.6:35b-a3b` | local, ~23 GB | MoE, 3B active: fast on mini PCs and iGPUs |
| `qwen3-coder-30b` | `qwen3-coder:30b` | local, ~19 GB | Coding MoE, no thinking mode |
| `gemma4-12b` | `gemma4:12b` | local, ~8 GB | Small machines |
| `deepseek-r1-32b` / `14b` / `8b` | `deepseek-r1:*` | local, 20 / 9 / 5 GB | R1 distills; weak at agent tool calls |
| `deepseek-v4-flash-cloud` | `deepseek-v4-flash:cloud` | Ollama Cloud | The real DeepSeek V4 |
| `deepseek-v4-pro-cloud` | `deepseek-v4-pro:cloud` | Ollama Cloud | DeepSeek flagship |
| `kimi-cloud` | checked live | Ollama Cloud | Kimi K3 is ~1.5 TB, too big to run locally |

Any other tag works too: `-m <tag>`. Every tag is verified against the Ollama
registry before installing, and on a Mac the MLX build is preferred when it exists.

Cloud models need an ollama.com account (`ollama signin` runs during install),
and your prompts and code leave the machine.

## What it changes

- **Ollama** installed (Homebrew on Mac, official installer on Linux) and run as a
  service with a 64K context and the model kept in memory:
  - macOS: LaunchAgent `~/Library/LaunchAgents/com.local.ollama.plist`
  - Linux: drop-in `/etc/systemd/system/ollama.service.d/override.conf`, or a user
    service, or a background process when there's no systemd
- **OpenCode** installed, and the model merged into `~/.config/opencode/opencode.json`
  as the default (other providers are kept; a timestamped backup is made).

## Options

```
-m, --model <id|tag>   catalog id or any Ollama tag
    --context <n>      context window in tokens  (default 65536)
    --port <n>         port for Ollama           (default 11434)
    --listen <addr>    127.0.0.1 or 0.0.0.0      (default 127.0.0.1)
-y, --yes              install without prompts
```

`--listen 0.0.0.0` lets other machines (say, a laptop running OpenCode) use this
server. Ollama has no authentication, so keep it behind your firewall.

## No Bun?

`setup.sh` does the same install with plain bash (`./setup.sh --doctor`, then
`MODEL=<tag> ./setup.sh`), without the model menu.
