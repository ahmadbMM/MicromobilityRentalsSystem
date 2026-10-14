#!/usr/bin/env bash
# The instant lane: push the site live from this machine in under a minute.
#
# CI is the safety net — every push still runs the full suite and deploys on
# green (~5-6 min). THIS is for the moments that cannot wait for a runner to
# wake up: it builds (1-2s), refuses to ship what git does not have, uploads
# straight to Cloudflare Pages, and prints what it did.
#
# One-time setup, either:
#   npx wrangler login                          # browser sign-in on this machine
# or put the two values in .env.deploy (gitignored, chmod 600):
#   CLOUDFLARE_API_TOKEN=...                    # a Pages:Edit token
#   CLOUDFLARE_ACCOUNT_ID=...
#
# Flags: --dirty  ship despite uncommitted changes (the guard exists because a
#                 live site running code that is in no commit is undebuggable).
#
# Two guards have no flag. Untracked files inside a folder that ships are refused: dist/ copies
# those folders whole, so a work-in-progress functions/api/x.js would go live as an endpoint.
# And HEAD must be exactly origin/main: CI deploys origin/main, so shipping from a checkout that
# is behind it rolls production back, and shipping unpushed commits puts code live that CI will
# overwrite on its next run. Push or pull first.
set -euo pipefail
cd "$(dirname "$0")/.."
t0=$(date +%s)

[ -f .env.deploy ] && set -a && . ./.env.deploy && set +a

if [ "${1:-}" != "--dirty" ] && ! git diff --quiet HEAD -- . ':!dist'; then
  echo "✗ uncommitted changes — commit first, or run with --dirty" >&2
  git status --short | head -5 >&2
  exit 1
fi

# The folders dist/ copies whole (DIRS in scripts/assemble-dist.mjs). Ignored files count too,
# except macOS's .DS_Store, which wrangler never uploads.
SHIPPED_DIRS=$(node -e "import('./scripts/assemble-dist.mjs').then(m=>console.log(m.DIRS.join(' ')))")
# shellcheck disable=SC2086
stray=$(git ls-files --others -- $SHIPPED_DIRS | grep -Ev '(^|/)\.DS_Store$' || true)
if [ -n "$stray" ]; then
  echo "✗ files git does not track would ship — commit or remove them:" >&2
  echo "$stray" | head -10 >&2
  exit 1
fi

if ! git fetch --quiet origin main; then
  echo "✗ could not fetch origin/main to check this is what CI would ship — no deploy" >&2
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "✗ HEAD $(git rev-parse --short HEAD) is not origin/main $(git rev-parse --short origin/main) — push or pull first" >&2
  exit 1
fi

npm run build:html --silent
npm run build:wallet --silent
# the same stale guard CI runs (the same list): what we upload must match what git holds. It read
# index.html and service-worker.js alone, so a stale app.js, staff.js, staff part, pack, _headers
# (the CSP) or wallet function went live from here while git held another.
GENERATED="index.html app.js app.css lang staff-parts service-worker.js staff.js _headers functions/api/wallet-pass.js"
# shellcheck disable=SC2086
git diff --quiet -- $GENERATED || {
  [ "${1:-}" = "--dirty" ] || { echo "✗ the build changed generated files — commit them (or --dirty):" >&2; git diff --stat -- $GENERATED | tail -5 >&2; exit 1; }
}
node scripts/assemble-dist.mjs >/dev/null

# Fail fast and helpfully when nothing can authenticate — an unauthenticated wrangler
# otherwise sits waiting on an interactive prompt, which is the opposite of instant.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] \
   && [ ! -f "$HOME/Library/Preferences/.wrangler/config/default.toml" ] \
   && [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/.wrangler/config/default.toml" ]; then
  echo "✗ no Cloudflare auth on this machine. One-time setup, either:" >&2
  echo "    npx wrangler login          (browser sign-in)" >&2
  echo "    — or create .env.deploy with CLOUDFLARE_API_TOKEN=... and CLOUDFLARE_ACCOUNT_ID=..." >&2
  exit 1
fi

# CI=1 keeps wrangler strictly non-interactive: a broken credential errors instead of prompting.
CI=1 npx --yes wrangler@4.128.0 pages deploy dist \
  --project-name=micromobilityrentals --branch=main --commit-dirty=true

echo "── live in $(( $(date +%s) - t0 ))s · $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!dist' || echo ' +dirty') ──"
