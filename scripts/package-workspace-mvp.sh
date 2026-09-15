#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$project_dir/outputs/shared-workspace-mvp.tar.gz"
mkdir -p "$(dirname "$output")"

files=(
  "AGENTS.md"
  "docs/SHARED_WORKSPACES.md"
  "drizzle/0002_steep_mandrill.sql"
  "examples/publish-result.ts"
  "lib/workspaces/client.ts"
  "lib/workspaces/contracts.ts"
  "server/workspaces/gmail-adapter.ts"
  "server/workspaces/processors.ts"
  "server/workspaces/store.ts"
  "server/workspaces/validation.ts"
  "app/api/v1/[...path]/route.ts"
  "tests/workspaces.test.ts"
)

tar -czf "$output" -C "$project_dir" "${files[@]}"
printf '%s\n' "$output"
