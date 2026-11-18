#!/usr/bin/env bash
# Builds the web app and deploys it to production on the separate `acruxhub` Vercel team.
# The CLI login lives in .vercel-global (git-ignored) so it never touches other accounts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
G="$ROOT/.vercel-global"
V="npx -y vercel@65.11.0"
cd "$(dirname "$0")/../web"
npx tsc --noEmit -p .
npx vite build
$V pull --yes --environment production --global-config "$G" >/dev/null
$V build --prod --global-config "$G" >/dev/null
$V deploy --prebuilt --prod --global-config "$G" 2>&1 | grep -oE "https://acruxhub-[a-z0-9]+-acruxhub\.vercel\.app" | head -1
