#!/usr/bin/env bash
# One local validator (:8899) with Raydium's REAL mainnet programs cloned in, for
# testing the token launch (CPMM pool + Burn & Earn LP lock + keeper) and the
# launchpad's Raydium graduation for free. AcruxHub's AMM and launchpad are loaded
# too when built, upgradeable with keys/dev-wallet.json as authority.
# Usage via wsl.sh: bash scripts/raydium-localnet.sh run|start|stop
#   run   foreground (Ctrl-C to stop)   start  background, waits until healthy
set -e
MAIN=https://api.mainnet-beta.solana.com
dir=$HOME/raydium-ledger
DEPLOY="${CARGO_TARGET_DIR:-$PWD/target}/deploy"
ours() {
  [ -f keys/dev-wallet.json ] || return 0
  local auth; auth=$(solana-keygen pubkey keys/dev-wallet.json)
  for p in amm launchpad; do
    # LAUNCHPAD_SO loads a different launchpad binary, e.g. the one live on Acrux
    # (scripts/rehearse-go-live.sh starts from it and upgrades in place).
    local so="$DEPLOY/acruxhub_$p.so"
    [ "$p" = launchpad ] && [ -n "${LAUNCHPAD_SO:-}" ] && so="$LAUNCHPAD_SO"
    if [ -f "$so" ]; then
      printf -- '--upgradeable-program %s %s %s ' "$(solana-keygen pubkey keys/acruxhub_$p-keypair.json)" "$so" "$auth"
    fi
  done
}
args() {
  echo --ledger "$dir" --reset --quiet --url "$MAIN" \
    --rpc-port 8899 --faucet-port 9900 \
    --clone-upgradeable-program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C \
    --clone-upgradeable-program LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE \
    --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
    --clone D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2 \
    --clone 2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5 \
    --clone DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8 \
    $(ours)
}
case "${1:-run}" in
  run)
    rm -rf "$dir"
    exec solana-test-validator $(args) ;;
  start)
    rm -rf "$dir"
    nohup solana-test-validator $(args) > "$HOME/raydium-localnet.log" 2>&1 &
    echo $! > "$HOME/raydium-localnet.pid"
    for i in $(seq 1 120); do
      if curl -s -m 2 http://127.0.0.1:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok; then echo "raydium localnet on :8899 up"; exit 0; fi
      sleep 1
    done
    echo "validator did not come up; see ~/raydium-localnet.log"; exit 1 ;;
  stop)
    [ -f "$HOME/raydium-localnet.pid" ] && kill "$(cat $HOME/raydium-localnet.pid)" 2>/dev/null || true
    pkill -f raydium-ledger || true; echo stopped ;;
esac
