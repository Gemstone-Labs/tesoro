#!/usr/bin/env bash
# Builds Storybook from the committed HEAD (a throwaway worktree, so uncommitted work stays out)
# and deploys the static build to the Vercel project tesoro-storybook: https://tesoro-storybook.vercel.app
set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
WT=$(mktemp -d "${TMPDIR:-$HOME/.cache/tesoro-tmp}/storybook-deploy.XXXX")
trap 'git -C "$REPO" worktree remove --force "$WT"' EXIT

git -C "$REPO" worktree add --detach "$WT" HEAD
cd "$WT"
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @tesoro/app build-storybook

OUT="$WT/app/storybook-static"
mkdir -p "$OUT/.vercel"
echo '{"projectId":"prj_0AyjWQpHOXUtcaGVBlG9jNAZ7P7P","orgId":"team_Cd7cmqeT1QdBq9UEa9EYF92D"}' > "$OUT/.vercel/project.json"
cd "$OUT"
vercel deploy --prod --yes --scope gemstone-labs
