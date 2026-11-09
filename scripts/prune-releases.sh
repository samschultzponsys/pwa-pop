#!/usr/bin/env bash
# Deletes every GitHub release except the newest KEEP (default 1), plus old
# workflow runs. Git tags are always kept, so any version can be rebuilt from
# its tag (git checkout vX.Y && npm ci && npm run dist).
# Needs GH_TOKEN with contents:write (and actions:write for runs).
set -euo pipefail
KEEP="${KEEP:-1}"
KEEP_RUNS="${KEEP_RUNS:-10}"
REPO="${GITHUB_REPOSITORY:?}"

# Newest first by version number, not by date.
mapfile -t tags < <(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName' | sort -V -r)
echo "Releases: ${tags[*]:-none}; keeping the newest $KEEP"
for t in "${tags[@]:$KEEP}"; do
  echo "Deleting release $t (tag kept)"
  gh release delete "$t" --repo "$REPO" --yes
done

mapfile -t runs < <(gh api "repos/$REPO/actions/runs?per_page=100&status=completed" --jq '.workflow_runs[].id')
for id in "${runs[@]:$KEEP_RUNS}"; do
  gh api -X DELETE "repos/$REPO/actions/runs/$id" >/dev/null && echo "Deleted run $id" || echo "Could not delete run $id"
done
