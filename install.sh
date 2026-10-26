#!/usr/bin/env bash
# Install the standalone CLI from GitHub Releases; no source checkout required.
set -euo pipefail

main() {
  local target asset base tmp checksum_tool install_dir
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=darwin-arm64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
    *) echo "Unsupported system. Use macOS Apple Silicon or Linux x86_64/arm64." >&2; exit 1 ;;
  esac
  command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
  if command -v sha256sum >/dev/null; then
    checksum_tool=sha256sum
  elif command -v shasum >/dev/null; then
    checksum_tool=shasum
  else
    echo "sha256sum or shasum is required." >&2
    exit 1
  fi

  install_dir="${INSTALL_DIR:-$HOME/.local/bin}"
  base=https://github.com/marconvcm/local-coder/releases
  if [ -n "${VERSION:-}" ]; then
    [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
      echo "VERSION must be a release tag such as v0.1.0." >&2; exit 1;
    }
    base="$base/download/$VERSION"
  else
    base="$base/latest/download"
  fi
  asset="local-coder-$target"
  tmp=$(mktemp -d)
  trap 'rm -rf -- "$tmp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "Downloading $asset…"
  curl --fail --show-error --location --retry 3 "$base/$asset" -o "$tmp/$asset"
  curl --fail --show-error --location --retry 3 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
  awk -v asset="$asset" '$2 == asset { print }' "$tmp/SHA256SUMS" > "$tmp/checksum"
  [ "$(wc -l < "$tmp/checksum" | tr -d ' ')" = 1 ] || {
    echo "Release checksum is missing or ambiguous." >&2; exit 1;
  }
  (
    cd "$tmp"
    if [ "$checksum_tool" = sha256sum ]; then
      sha256sum -c checksum
    else
      shasum -a 256 -c checksum
    fi
  )
  mkdir -p "$install_dir"
  install -m 755 "$tmp/$asset" "$install_dir/local-coder"
  echo "Installed: $install_dir/local-coder"
  case ":$PATH:" in
    *":$install_dir:"*) echo "Run: local-coder" ;;
    *)
      echo "Add this line to your shell configuration (~/.zshrc or ~/.bashrc):"
      printf 'export PATH=%q:"$PATH"\n' "$install_dir"
      ;;
  esac
  rm -rf -- "$tmp"
  trap - EXIT
}

main "$@"
