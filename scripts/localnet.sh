#!/usr/bin/env bash
# Starts two local SVM chains in WSL for end-to-end tests:
#   chain A ("solana", id 1) RPC :8899   chain B ("acrux", id 2) RPC :8999
# All three programs are loaded upgradeable with keys/dev-wallet.json as authority.
# Usage (inside WSL, via wsl.sh): scripts/localnet.sh start|stop
set -e
DEPLOY="${CARGO_TARGET_DIR:-$PWD/target}/deploy"
AUTH=$(solana-keygen pubkey keys/dev-wallet.json)
progs() {
  for p in amm launchpad bridge wacrux locker; do
    printf -- '--upgradeable-program %s %s %s ' "$(solana-keygen pubkey keys/acruxhub_$p-keypair.json)" "$DEPLOY/acruxhub_$p.so" "$AUTH"
  done
}
start_one() { # name rpc_port faucet_port gossip_port port_range
  local dir=$HOME/acruxhub-ledger-$1
  rm -rf "$dir"
  nohup solana-test-validator --ledger "$dir" --reset --quiet \
    --rpc-port $2 --faucet-port $3 --gossip-port $4 --dynamic-port-range $5 \
    $(progs) > "$HOME/acruxhub-$1.log" 2>&1 &
  echo $! > "$HOME/acruxhub-$1.pid"
}
case "$1" in
  run)
    start_one solana 8899 9900 8000 8100-8200
    start_one acrux 8999 9901 8300 8400-8500
    trap "kill $(cat $HOME/acruxhub-solana.pid) $(cat $HOME/acruxhub-acrux.pid) 2>/dev/null" EXIT
    wait ;;
  start)
    start_one solana 8899 9900 8000 8100-8200
    start_one acrux 8999 9901 8300 8400-8500
    for port in 8899 8999; do
      for i in $(seq 1 90); do
        if curl -s -m 2 http://127.0.0.1:$port -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok; then echo "chain on :$port up"; break; fi
        sleep 1
      done
    done ;;
  stop)
    for n in solana acrux; do [ -f "$HOME/acruxhub-$n.pid" ] && kill "$(cat $HOME/acruxhub-$n.pid)" 2>/dev/null || true; done
    pkill -f acruxhub-ledger || true; echo stopped ;;
esac
