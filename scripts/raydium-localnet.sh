#!/usr/bin/env bash
# One local validator (:8899) with Raydium's REAL mainnet programs cloned in, for
# testing the token launch (CPMM pool + Burn & Earn LP lock + keeper) for free.
# Usage via wsl.sh: bash scripts/raydium-localnet.sh run   (stop with: pkill -f raydium-ledger)
set -e
MAIN=https://api.mainnet-beta.solana.com
dir=$HOME/raydium-ledger
rm -rf "$dir"
exec solana-test-validator --ledger "$dir" --reset --quiet --url "$MAIN" \
  --rpc-port 8899 --faucet-port 9900 \
  --clone-upgradeable-program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C \
  --clone-upgradeable-program LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2 \
  --clone DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8
