#!/usr/bin/env bash
# Runs a command inside WSL with the Solana/Anchor toolchain on PATH.
# Build output goes to the WSL filesystem (much faster than /mnt/c).
source ~/.cargo/env 2>/dev/null
export PATH="$HOME/agave4/active_release/bin:$HOME/.avm/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/acruxhub-target"
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
if [ -f "$1" ]; then source "$1"; else eval "$@"; fi
