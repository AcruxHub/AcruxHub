#!/usr/bin/env bash
# Rehearses the Acrux go-live on a local chain (free): starts from the launchpad
# binary that is live on Acrux, then does the exact in-place upgrade (extend, deploy)
# and runs the go-live scripts against it. Run from Windows Git Bash:
#   bash scripts/rehearse-go-live.sh
# Needs the upgrade built (anchor build -p acruxhub_launchpad, via wsl.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
run_wsl() { printf '%s\n' "$1" > .wslcmd.sh; MSYS_NO_PATHCONV=1 wsl.exe -e bash /mnt/c/Users/lloyd/dev/acruxhub/wsl.sh /mnt/c/Users/lloyd/dev/acruxhub/.wslcmd.sh; }
mkdir -p .tmp

echo "== copy the live launchpad binary from Acrux and start a local chain with it"
run_wsl '
[ -f .tmp/launchpad-live-v1.so ] || solana program dump -u https://rpc.acrux.computer 3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd .tmp/launchpad-live-v1.so
bash scripts/localnet.sh stop >/dev/null 2>&1 || true
bash scripts/raydium-localnet.sh stop >/dev/null 2>&1 || true
LAUNCHPAD_SO=$PWD/.tmp/launchpad-live-v1.so bash scripts/raydium-localnet.sh start | tail -1'

node --import tsx scripts/rehearse-go-live.ts 1

echo "== upgrade in place, as we will on Acrux: extend the program account, then deploy"
run_wsl '
NEW=$CARGO_TARGET_DIR/deploy/acruxhub_launchpad.so
OLD=$(solana program show 3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd -u localhost --output json | python3 -c "import json,sys;print(json.load(sys.stdin)[\"dataLen\"])")
GROW=$(( $(stat -c %s $NEW) - OLD ))
echo "program data $OLD bytes, new binary $(stat -c %s $NEW), extending by $GROW"
solana program extend 3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd $GROW -u localhost -k keys/dev-wallet.json
solana program deploy $NEW --program-id keys/acruxhub_launchpad-keypair.json --upgrade-authority keys/dev-wallet.json -u localhost -k keys/dev-wallet.json'

node --import tsx scripts/rehearse-go-live.ts 2

echo "== stop the chain"
run_wsl 'bash scripts/raydium-localnet.sh stop'
