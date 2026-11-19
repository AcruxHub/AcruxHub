#!/usr/bin/env bash
# Builds the web app and deploys it to production on the separate `acruxhub` Vercel team.
# The CLI login lives in .vercel-global (git-ignored) so it never touches other accounts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
G="$ROOT/.vercel-global"
V="npx -y vercel@65.11.0"
cd "$(dirname "$0")/../web"
# The site sends the accounts the launchpad in this repo expects. If the live
# launchpad on Acrux Net is an older build (smaller than the one this site was
# built for), deploying would break buys and launches. Refuse unless FORCE=1.
NEED_LAUNCHPAD_BYTES=589152
LIVE=$(curl -s https://rpc.acrux.computer -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["JGZFP11vsgFPoQJAvYDfzE8LF9NeVFMfa2tJSozs5CE",{"encoding":"base64","dataSlice":{"offset":0,"length":0}}]}'   | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s).result.value;console.log(v?v.space-45:0)}catch{console.log(0)}})")
if [ "${FORCE:-0}" != "1" ] && [ "$LIVE" -lt "$NEED_LAUNCHPAD_BYTES" ]; then
  echo "Refusing to deploy: live launchpad holds $LIVE bytes, this site needs the $NEED_LAUNCHPAD_BYTES-byte build."
  echo "Upgrade the launchpad first (docs/dev-launchpad-upgrade.md), or FORCE=1 if you know it's safe."
  exit 1
fi
npx tsc --noEmit -p .
npx vite build
$V pull --yes --environment production --global-config "$G" >/dev/null
$V build --prod --global-config "$G" >/dev/null
$V deploy --prebuilt --prod --global-config "$G" 2>&1 | grep -oE "https://acruxhub-[a-z0-9]+-acruxhub\.vercel\.app" | head -1
