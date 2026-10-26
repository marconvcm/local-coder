#!/usr/bin/env bash
#
# setup-local-coding-model.sh
#
# Sets up a local coding agent on macOS (Apple Silicon) or Linux (x86_64 / arm64):
#   - Ollama (model server) running as a background service with a 64K context
#     and the model kept resident in memory
#       macOS: per-user LaunchAgent
#       Linux: systemd (drop-in override for the official service, or a user
#              service as fallback), or a plain background process without systemd
#   - Qwen3.8-27B pulled and warmed up (MLX build on macOS, GGUF on Linux)
#   - OpenCode installed and configured to use the local model
#
# Usage:
#   ./setup-local-coding-model.sh            install and configure everything
#   ./setup-local-coding-model.sh --doctor   check that the machine is ready (changes nothing)
#   ./setup-local-coding-model.sh --help     show this help
#
# Optional overrides (environment variables):
#   MODEL            Ollama model tag            (default: per OS, see below)
#   CONTEXT_LENGTH   context window in tokens    (default: 65536)
#   OLLAMA_PORT      port Ollama listens on      (default: 11434)
#   LISTEN_ADDR      address Ollama binds to     (default: 127.0.0.1)
#                    use 0.0.0.0 to serve other machines on your network
#
# Examples:
#   ./setup-local-coding-model.sh --doctor
#   CONTEXT_LENGTH=32768 ./setup-local-coding-model.sh
#   MODEL=qwen3.6:35b-a3b LISTEN_ADDR=0.0.0.0 ./setup-local-coding-model.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --doctor|doctor) MODE="doctor" ;;
    -h|--help)       usage; exit 0 ;;
    *)               echo "Unknown option: $arg" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Output helpers (counters are used by the doctor summary)
# ---------------------------------------------------------------------------
PASS=0; WARNS=0; FAILS=0

info()    { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()      { PASS=$((PASS + 1));   printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn()    { WARNS=$((WARNS + 1)); printf '\033[1;33m !\033[0m %s\n' "$*"; }
bad()     { FAILS=$((FAILS + 1)); printf '\033[1;31m ✗\033[0m %s\n' "$*"; }
note()    { printf '   %s\n' "$*"; }
fail()    { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

# In doctor mode a blocking problem is recorded; in install mode it aborts.
blocker() { if [[ "$MODE" == "doctor" ]]; then bad "$@"; else fail "$*"; fi; }

SUDO=""
if [[ $EUID -ne 0 ]]; then SUDO="sudo"; fi

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------
detect_platform() {
  OS_RAW="$(uname -s)"
  ARCH_RAW="$(uname -m)"
  OS=""; ARCH=""

  case "$OS_RAW" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
  esac
  case "$ARCH_RAW" in
    x86_64|amd64)  ARCH="x86_64" ;;
    arm64|aarch64) ARCH="arm64" ;;
  esac

  if [[ -z "$OS" ]]; then
    blocker "Unsupported OS: ${OS_RAW}. Only macOS and Linux are supported."
  elif [[ -z "$ARCH" ]]; then
    blocker "Unsupported architecture: ${ARCH_RAW}. Only x86_64 and arm64 are supported."
  elif [[ "$OS" == "macos" && "$ARCH" != "arm64" ]]; then
    blocker "Intel Macs are not supported. Apple Silicon is required."
  else
    ok "Platform: ${OS} / ${ARCH}"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Configuration (needs OS, so it is resolved after detection)
# ---------------------------------------------------------------------------
configure() {
  if [[ "$OS" == "macos" ]]; then
    DEFAULT_MODEL="qwen3.8:27b-mlx"   # runs on Apple's MLX backend
  else
    DEFAULT_MODEL="qwen3.8:27b"       # GGUF build (CUDA / ROCm / Vulkan / CPU)
  fi

  MODEL="${MODEL:-$DEFAULT_MODEL}"
  FALLBACK_MODEL="${FALLBACK_MODEL:-qwen3.8:27b}"
  CONTEXT_LENGTH="${CONTEXT_LENGTH:-65536}"   # OpenCode needs at least ~64K
  OLLAMA_PORT="${OLLAMA_PORT:-11434}"
  LISTEN_ADDR="${LISTEN_ADDR:-127.0.0.1}"
  OLLAMA_URL="http://127.0.0.1:${OLLAMA_PORT}"
  REQUIRED_DISK_GB=25                          # ~18 GB model + headroom

  # Make every `ollama` CLI call in this script talk to the right server
  export OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}"

  OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
  OPENCODE_CONFIG="${OPENCODE_CONFIG_DIR}/opencode.json"
  SYSTEMD_DROPIN="/etc/systemd/system/ollama.service.d/override.conf"

  # Environment for the Ollama server (shared by all service backends)
  SERVER_ENV=(
    "OLLAMA_HOST=${LISTEN_ADDR}:${OLLAMA_PORT}"
    "OLLAMA_CONTEXT_LENGTH=${CONTEXT_LENGTH}"
    "OLLAMA_KEEP_ALIVE=-1"
    "OLLAMA_FLASH_ATTENTION=1"
  )
}

# ---------------------------------------------------------------------------
# Shared probes
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

has_systemd() { have systemctl && [[ -d /run/systemd/system ]]; }

ollama_responding() { curl -fsS --max-time 3 "${OLLAMA_URL}/api/version" >/dev/null 2>&1; }

wait_for_ollama() {
  local tries=45
  until ollama_responding; do
    tries=$((tries - 1))
    [[ $tries -le 0 ]] && return 1
    sleep 1
  done
}

port_in_use() {
  local port="$1"
  if have lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif have ss; then
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .
  else
    return 2   # cannot tell
  fi
}

# Prints the HTTP status code for a URL, or 000 if unreachable
http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || true
}

# Prints the registry HTTP code for an Ollama model tag (200 = exists, 404 = missing)
registry_code() {
  local model="$1" repo tag="latest"
  repo="${model%%:*}"
  [[ "$model" == *:* ]] && tag="${model#*:}"
  [[ "$repo" == */* ]] || repo="library/${repo}"
  http_code -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    "https://registry.ollama.ai/v2/${repo}/manifests/${tag}"
}

# Where Ollama will store models
models_dir() {
  if [[ -n "${OLLAMA_MODELS:-}" ]]; then
    echo "$OLLAMA_MODELS"
  elif [[ "$OS" == "linux" ]] && { systemctl cat ollama.service >/dev/null 2>&1 || ! have ollama; } && has_systemd; then
    echo "/usr/share/ollama/.ollama/models"   # official installer's service user
  else
    echo "${HOME}/.ollama/models"
  fi
}

free_gb_at() {
  local dir="$1"
  while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
  df -Pk "$dir" | awk 'NR==2 {print int($4 / 1024 / 1024)}'
}

# ---------------------------------------------------------------------------
# Hardware report (used by both install and doctor)
# ---------------------------------------------------------------------------
check_hardware() {
  if [[ "$OS" == "macos" ]]; then
    RAM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
    local wired_mb gpu_gb
    wired_mb="$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)"
    if [[ "$wired_mb" =~ ^[0-9]+$ ]] && (( wired_mb > 0 )); then
      gpu_gb=$(( wired_mb / 1024 ))
    else
      gpu_gb=$(( RAM_GB * 3 / 4 ))   # macOS default: ~75% of unified memory
    fi
    if (( gpu_gb >= 24 )); then
      ok "${RAM_GB} GB unified memory (~${gpu_gb} GB usable by the GPU)"
    else
      warn "${RAM_GB} GB unified memory (~${gpu_gb} GB usable by the GPU)."
      note "The 27B model (~18 GB) plus a 64K context will be tight."
      note "Consider CONTEXT_LENGTH=32768 or a smaller model."
    fi
    return
  fi

  RAM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
  if (( RAM_GB >= 32 )); then
    ok "${RAM_GB} GB system RAM"
  else
    warn "${RAM_GB} GB system RAM: the 27B model plus a 64K context will be tight."
  fi

  if have nvidia-smi && nvidia-smi >/dev/null 2>&1; then
    local vram_mb gpu_name vram_gb
    vram_mb="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1 | tr -d ' ')"
    gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
    vram_gb=$(( ${vram_mb:-0} / 1024 ))
    if (( vram_gb >= 20 )); then
      ok "NVIDIA GPU: ${gpu_name} (${vram_gb} GB VRAM)"
    else
      warn "NVIDIA GPU: ${gpu_name} (${vram_gb} GB VRAM). The 27B needs ~18 GB plus context,"
      note "so part of it will run on the CPU and be slow. Consider a MoE model, e.g.:"
      note "  MODEL=qwen3.6:35b-a3b ./setup-local-coding-model.sh"
    fi
  elif have lspci && lspci 2>/dev/null | grep -qi 'vga.*nvidia\|3d.*nvidia'; then
    warn "NVIDIA GPU found but the driver is not working (nvidia-smi failed or missing)."
    note "Install the NVIDIA driver first, or Ollama will run on the CPU."
  elif [[ -e /dev/kfd ]]; then
    ok "AMD GPU detected (Ollama will use ROCm or Vulkan if supported)"
  else
    warn "No dedicated GPU detected. Ollama will run on the CPU or an integrated GPU."
  fi
}

# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------
run_doctor() {
  printf '\033[1mDoctor: checking whether this machine is ready (nothing will be changed)\033[0m\n'

  info "Platform"
  if ! detect_platform; then
    doctor_summary
  fi
  configure
  note "Model to install: ${MODEL}  |  context: ${CONTEXT_LENGTH}  |  port: ${OLLAMA_PORT}  |  bind: ${LISTEN_ADDR}"

  info "Required tools"
  if have curl; then ok "curl found"; else bad "curl not found (required)"; fi

  if [[ "$OS" == "macos" ]]; then
    if have brew; then ok "Homebrew found ($(brew --version 2>/dev/null | head -n1))"
    else bad "Homebrew not found. Install it from https://brew.sh"; fi
  else
    if [[ $EUID -eq 0 ]]; then
      ok "Running as root"
    elif have sudo; then
      if sudo -n true 2>/dev/null; then ok "sudo available (no password needed)"
      else ok "sudo available (you will be asked for your password)"; fi
    elif have ollama; then
      warn "sudo not found: the system service cannot be configured; a user service will be used."
    else
      bad "sudo not found and not running as root: the Ollama installer needs root."
    fi

    if has_systemd; then
      ok "systemd available"
    else
      warn "systemd not available: Ollama will run as a plain background process (no auto-start)."
    fi
  fi

  info "Hardware"
  check_hardware

  info "Disk space"
  local mdir free
  mdir="$(models_dir)"
  free="$(free_gb_at "$mdir")"
  if (( free >= REQUIRED_DISK_GB )); then
    ok "${free} GB free for models (${mdir})"
  else
    bad "Only ${free} GB free for models (${mdir}); at least ${REQUIRED_DISK_GB} GB recommended."
  fi

  info "Network"
  local code
  if [[ "$OS" == "linux" ]] && ! have ollama; then
    code="$(http_code -I https://ollama.com/install.sh)"
    if [[ "$code" != "000" ]]; then ok "ollama.com reachable (installer)"
    else bad "Cannot reach ollama.com (needed to download the Ollama installer)"; fi
  fi
  code="$(http_code https://registry.ollama.ai/v2/)"
  if [[ "$code" != "000" ]]; then ok "registry.ollama.ai reachable (model download)"
  else bad "Cannot reach registry.ollama.ai (needed to download the model)"; fi
  if ! have opencode && [[ ! -x "${HOME}/.opencode/bin/opencode" ]]; then
    code="$(http_code -I https://opencode.ai/install)"
    if [[ "$code" != "000" ]]; then ok "opencode.ai reachable (installer)"
    else bad "Cannot reach opencode.ai (needed to download the OpenCode installer)"; fi
  fi

  info "Model"
  code="$(registry_code "$MODEL")"
  case "$code" in
    200) ok "${MODEL} exists in the Ollama registry" ;;
    404)
      if [[ "$MODEL" != "$FALLBACK_MODEL" && "$(registry_code "$FALLBACK_MODEL")" == "200" ]]; then
        warn "${MODEL} not found in the registry; the fallback ${FALLBACK_MODEL} will be used."
      else
        bad "${MODEL} not found in the Ollama registry. Check the tag or set MODEL=..."
      fi ;;
    000) warn "Could not verify ${MODEL} in the registry (network problem)." ;;
    *)   warn "Could not verify ${MODEL} in the registry (HTTP ${code})." ;;
  esac

  info "Current installation"
  if have ollama; then
    ok "Ollama installed ($(ollama --version 2>/dev/null | grep -o '[0-9][0-9.]*' | head -n1 || echo 'unknown version'))"
  else
    note "Ollama not installed yet (will be installed)"
  fi

  if ollama_responding; then
    ok "Ollama already running on port ${OLLAMA_PORT} (it will be restarted with the new settings)"
    if curl -fsS "${OLLAMA_URL}/api/tags" 2>/dev/null | grep -q "\"name\":\"${MODEL}\""; then
      ok "${MODEL} already downloaded (no download needed)"
    fi
  else
    local rc=0
    port_in_use "$OLLAMA_PORT" || rc=$?
    case "$rc" in
      0) bad "Port ${OLLAMA_PORT} is used by another program. Free it or set OLLAMA_PORT=..." ;;
      1) ok "Port ${OLLAMA_PORT} is free" ;;
      *) warn "Could not check port ${OLLAMA_PORT} (neither lsof nor ss is available)" ;;
    esac
  fi

  if [[ "$OS" == "macos" ]]; then
    if pgrep -xq Ollama 2>/dev/null; then
      note "The Ollama desktop app is running; it will be quit and replaced by a LaunchAgent."
    fi
    if have brew && brew services list 2>/dev/null | grep -q '^ollama .*started'; then
      note "The Ollama brew service is running; it will be stopped and replaced by a LaunchAgent."
    fi
  elif [[ -f "$SYSTEMD_DROPIN" ]] && ! grep -q 'setup-local-coding-model' "$SYSTEMD_DROPIN" 2>/dev/null; then
    warn "${SYSTEMD_DROPIN} exists and was not created by this script; it will be overwritten."
  fi

  if have opencode || [[ -x "${HOME}/.opencode/bin/opencode" ]]; then
    ok "OpenCode installed"
  else
    note "OpenCode not installed yet (will be installed)"
  fi

  if [[ -f "$OPENCODE_CONFIG" ]]; then
    warn "${OPENCODE_CONFIG} exists; it will be backed up and replaced."
    note "Copy any other providers back from the backup afterwards."
  fi

  if [[ "$LISTEN_ADDR" == "0.0.0.0" ]]; then
    warn "LISTEN_ADDR=0.0.0.0 exposes Ollama to your network with no authentication."
  fi

  doctor_summary
}

doctor_summary() {
  printf '\n\033[1mSummary:\033[0m %d passed, %d warning(s), %d problem(s)\n' "$PASS" "$WARNS" "$FAILS"
  if (( FAILS > 0 )); then
    printf '\033[1;31mNot ready.\033[0m Fix the problems marked with ✗ and run --doctor again.\n'
    exit 1
  elif (( WARNS > 0 )); then
    printf '\033[1;33mReady, with warnings.\033[0m Review the items marked with ! before installing.\n'
  else
    printf '\033[1;32mReady to install.\033[0m Run the script without --doctor.\n'
  fi
  exit 0
}

if [[ "$MODE" == "doctor" ]]; then
  run_doctor
fi

# ===========================================================================
# Install
# ===========================================================================

# ---------------------------------------------------------------------------
# 1. Platform and hardware
# ---------------------------------------------------------------------------
info "Detecting platform"
detect_platform
configure
have curl || fail "Required command not found: curl"

info "Checking hardware"
check_hardware

# ---------------------------------------------------------------------------
# 2. Install Ollama
# ---------------------------------------------------------------------------
info "Installing Ollama"

if [[ "$OS" == "macos" ]]; then
  have brew || fail "Homebrew not found. Install it from https://brew.sh and run this script again."
  if brew list ollama >/dev/null 2>&1; then
    brew upgrade ollama >/dev/null 2>&1 || true
    ok "Ollama already installed ($(ollama --version 2>/dev/null | head -n1))"
  else
    brew install ollama
    ok "Ollama installed"
  fi
  OLLAMA_BIN="$(brew --prefix)/bin/ollama"
else
  if have ollama; then
    ok "Ollama already installed ($(ollama --version 2>/dev/null | head -n1))"
  else
    # Official installer: detects the architecture and GPU (CUDA/ROCm),
    # and creates a systemd service when systemd is available.
    curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama installed"
  fi
  OLLAMA_BIN="$(command -v ollama)"
fi

# ---------------------------------------------------------------------------
# 3. Run Ollama as a background service with the right environment
# ---------------------------------------------------------------------------
info "Configuring Ollama service"

SERVICE_KIND=""

setup_macos_launchagent() {
  local label="com.local.ollama"
  local plist="${HOME}/Library/LaunchAgents/${label}.plist"
  local log="${HOME}/Library/Logs/ollama.log"

  # Free the port: stop other Ollama instances (brew service or desktop app)
  brew services stop ollama >/dev/null 2>&1 || true
  osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
  pkill -f "ollama serve" >/dev/null 2>&1 || true
  sleep 1

  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"

  local env_xml="" kv
  for kv in "${SERVER_ENV[@]}"; do
    env_xml+="    <key>${kv%%=*}</key>"$'\n'"    <string>${kv#*=}</string>"$'\n'
  done

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${OLLAMA_BIN}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env_xml}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"

  SERVICE_KIND="launchd"
  LOGS_CMD="tail -f ${log}"
  STOP_CMD="launchctl bootout gui/\$(id -u)/${label}"
  START_CMD="launchctl bootstrap gui/\$(id -u) ${plist}"
}

setup_linux_system_service() {
  # The official installer creates ollama.service; add a drop-in with our env.
  local kv
  [[ -n "$SUDO" ]] && $SUDO -v
  $SUDO mkdir -p "$(dirname "$SYSTEMD_DROPIN")"
  {
    echo "# Managed by setup-local-coding-model.sh"
    echo "[Service]"
    for kv in "${SERVER_ENV[@]}"; do echo "Environment=\"${kv}\""; done
  } | $SUDO tee "$SYSTEMD_DROPIN" >/dev/null

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable ollama >/dev/null 2>&1 || true
  $SUDO systemctl restart ollama

  SERVICE_KIND="systemd (system)"
  LOGS_CMD="journalctl -u ollama -f"
  STOP_CMD="sudo systemctl stop ollama"
  START_CMD="sudo systemctl start ollama"
}

setup_linux_user_service() {
  # No system unit (e.g. Ollama installed some other way): use a user unit.
  local unit_dir="${HOME}/.config/systemd/user" kv
  mkdir -p "$unit_dir"
  {
    echo "# Managed by setup-local-coding-model.sh"
    echo "[Unit]"
    echo "Description=Ollama (local model server)"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    echo "ExecStart=${OLLAMA_BIN} serve"
    for kv in "${SERVER_ENV[@]}"; do echo "Environment=\"${kv}\""; done
    echo "Restart=always"
    echo "RestartSec=3"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "${unit_dir}/ollama.service"

  pkill -f "ollama serve" >/dev/null 2>&1 || true
  systemctl --user daemon-reload
  systemctl --user enable --now ollama
  systemctl --user restart ollama

  # Keep the user service running after logout (may ask for a password)
  if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
    $SUDO loginctl enable-linger "$USER" >/dev/null 2>&1 || \
      warn "Could not enable lingering: Ollama will stop when you log out."
  fi

  SERVICE_KIND="systemd (user)"
  LOGS_CMD="journalctl --user -u ollama -f"
  STOP_CMD="systemctl --user stop ollama"
  START_CMD="systemctl --user start ollama"
}

setup_linux_background_process() {
  # No systemd (containers, WSL without systemd, etc.)
  local log_dir="${HOME}/.local/state/ollama"
  mkdir -p "$log_dir"
  pkill -f "ollama serve" >/dev/null 2>&1 || true
  sleep 1
  env "${SERVER_ENV[@]}" nohup "$OLLAMA_BIN" serve >"${log_dir}/ollama.log" 2>&1 &
  warn "systemd not available: Ollama started as a background process."
  note "It will NOT restart after a reboot. Re-run this script or start it manually."

  SERVICE_KIND="background process"
  LOGS_CMD="tail -f ${log_dir}/ollama.log"
  STOP_CMD="pkill -f 'ollama serve'"
  START_CMD="env ${SERVER_ENV[*]} nohup ${OLLAMA_BIN} serve >${log_dir}/ollama.log 2>&1 &"
}

if [[ "$OS" == "macos" ]]; then
  setup_macos_launchagent
elif has_systemd && systemctl cat ollama.service >/dev/null 2>&1; then
  setup_linux_system_service
elif has_systemd; then
  setup_linux_user_service
else
  setup_linux_background_process
fi

wait_for_ollama || fail "Ollama did not start. Check the logs: ${LOGS_CMD}"
ok "Ollama running via ${SERVICE_KIND} on ${LISTEN_ADDR}:${OLLAMA_PORT} (context ${CONTEXT_LENGTH}, keep-alive forever)"
if [[ "$LISTEN_ADDR" == "0.0.0.0" ]]; then
  warn "Ollama is reachable from your network with no authentication. Keep it behind your firewall."
fi

# ---------------------------------------------------------------------------
# 4. Pull the model
# ---------------------------------------------------------------------------
info "Pulling ${MODEL} (~18 GB for the 27B; time depends on your connection)"
if ! "$OLLAMA_BIN" pull "$MODEL"; then
  if [[ "$MODEL" != "$FALLBACK_MODEL" ]]; then
    warn "Could not pull ${MODEL}, falling back to ${FALLBACK_MODEL}"
    MODEL="$FALLBACK_MODEL"
    "$OLLAMA_BIN" pull "$MODEL" || fail "Could not pull ${MODEL}"
  else
    fail "Could not pull ${MODEL}"
  fi
fi
ok "Model ready: ${MODEL}"

# ---------------------------------------------------------------------------
# 5. Install OpenCode
# ---------------------------------------------------------------------------
info "Installing OpenCode"
export PATH="${HOME}/.opencode/bin:${PATH}"
if have opencode; then
  ok "OpenCode already installed ($(opencode --version 2>/dev/null | head -n1))"
else
  # Official installer: supports macOS and Linux on x86_64 and arm64
  curl -fsSL https://opencode.ai/install | bash
  if have opencode; then
    ok "OpenCode installed"
  else
    warn "OpenCode installed, but not on PATH yet. Open a new terminal."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Configure OpenCode to use the local model
# ---------------------------------------------------------------------------
info "Writing OpenCode config"
mkdir -p "$OPENCODE_CONFIG_DIR"
if [[ -f "$OPENCODE_CONFIG" ]]; then
  BACKUP="${OPENCODE_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$OPENCODE_CONFIG" "$BACKUP"
  warn "Existing config backed up to ${BACKUP}"
fi

cat > "$OPENCODE_CONFIG" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "${OLLAMA_URL}/v1"
      },
      "models": {
        "${MODEL}": {
          "name": "${MODEL} (local)",
          "limit": {
            "context": ${CONTEXT_LENGTH},
            "output": 16384
          }
        }
      }
    }
  },
  "model": "ollama/${MODEL}"
}
EOF
ok "OpenCode config written to ${OPENCODE_CONFIG}"

# ---------------------------------------------------------------------------
# 7. Warm up and smoke test
# ---------------------------------------------------------------------------
info "Loading the model into memory (first load can take a minute or two)"
START=$(date +%s)
if curl -fsS --max-time 600 "${OLLAMA_URL}/api/generate" \
     -d "{\"model\": \"${MODEL}\", \"prompt\": \"Reply with the single word OK.\", \"stream\": false}" \
     >/dev/null 2>&1; then
  ok "Model responded in $(( $(date +%s) - START ))s"
else
  warn "Warm-up request failed. Try: ollama run ${MODEL}"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m')Setup complete.$(printf '\033[0m')

  Start coding:      cd /path/to/your/repo && opencode
  Check the model:   ollama ps
  Server logs:       ${LOGS_CMD}
  Stop the server:   ${STOP_CMD}
  Start it again:    ${START_CMD}
  Check the setup:   $0 --doctor

Tip: Qwen3.8-27B thinks a lot by default. For quick interactive edits,
lower the reasoning effort; keep it high for long agent runs.
EOF
