# Shared workspace MVP

## Introduction for the next model

The feature is already built and tested in this repository. It moves reusable results out of one browser, machine, or user account and into a durable team workspace.

The central rule is:

> A workspace owns artifacts. A user or integration authors them. Every authorized member reads the same stored artifact.

An artifact is an immutable JSON result. `brief.corpus` stores compressed source extracts. `brief.fold` stores a derived grouping and points back to its corpus through `parentIds`. Future apps publish their own namespaced kinds, such as `linear.issue_digest`, through the same interface.

The MVP includes durable workspaces, owner/editor/viewer membership, single-use invitations, immutable artifacts with lineage, deterministic compression and folding, workspace-scoped integration keys, an event feed, an explicit Gmail-summary adapter, and a `/team` UI.

Keep this model stable during a port. Make the MVP pass the completion checks before extending it.

## Small interface

All producers create this object:

```ts
type ArtifactInput = {
  kind: string; // namespaced, e.g. "acme.analysis"
  schemaVersion: number;
  title: string;
  summary: string;
  content: Record<string, Json>;
  provenance: Record<string, Json>;
  parentIds: string[]; // existing artifacts in the same workspace
};
```

All consumers need four operations:

```ts
client.list(workspaceId, filters)
client.get(workspaceId, artifactId)
client.publish(workspaceId, artifact, idempotencyKey)
client.events(workspaceId, afterSequence)
```

The server-side module is `new WorkspaceStore(db, principal)`. It owns authorization, validation, persistence, idempotency, lineage, invitations, integration keys, and events. Callers never write workspace tables directly.

## Port the MVP

### 1. Inspect the target project

Locate its authenticated-user function, database binding, mutation-origin check, JSON response helper, route convention, TypeScript path aliases, and migration system. Finish when each item has an exact target-project equivalent.

### 2. Copy the core

Run:

```sh
npm run workspace:mvp
```

This creates `outputs/shared-workspace-mvp.tar.gz` with the contract, client, server module, route, migration, tests, example producer, and this handoff. Extract it at the target repository root.

The Gmail adapter is included to reproduce this MVP. If the target has no Gmail snapshot, remove the `/capture` route branch and `gmail-adapter.ts` after the shared artifact flow passes.

### 3. Adapt three seams

Keep the workspace module unchanged at first. Adapt only:

1. `runtime().DB` to the target project’s D1-compatible database binding.
2. `getChatGPTUser()` to verified server-side identity with a stable user ID and display name.
3. `mutation(request)` to the target project’s exact-origin or CSRF check.

`HttpError` only needs `status` and `message`. `json()` must return JSON with `Cache-Control: private, no-store`.

For an OpenAI Site, reuse `app/chatgpt-auth.ts`; trust forwarded identity headers only behind the Sites dispatcher. For another host, verify its session or JWT server-side. Never accept a user ID or role from request JSON.

### 4. Apply persistence

Use the six `workspace_*` tables in `drizzle/0002_steep_mandrill.sql`. Preserve these constraints:

| Invariant | Database enforcement |
| --- | --- |
| One membership per user/workspace | primary key `(workspace_id, user_id)` |
| Roles are bounded | CHECK `owner/editor/viewer` |
| Keys and invites are not stored raw | unique SHA-256 token hashes |
| A retry creates one artifact | unique `(workspace_id, created_by, request_key)` |
| Lists are stable | index `(workspace_id, created, id)` |
| Events resume by cursor | monotonic `sequence` plus workspace index |

Translate this migration through the target migration system. Schema creation belongs in migrations, never request handlers. Applied migrations remain immutable.

### 5. Wire the route

Mount the copied handler at `/api/v1/[...path]`, or translate its branches to the target router. Keep these endpoint groups:

| Route | Purpose |
| --- | --- |
| `GET/POST /workspaces` | list or create human workspaces |
| `POST /join` | redeem a single-use invitation |
| `GET/POST /workspaces/:id/artifacts` | list metadata or publish an artifact |
| `GET /workspaces/:id/artifacts/:artifactId` | read the full shared result |
| `POST /workspaces/:id/artifacts/:artifactId/fold` | derive a fold |
| `GET /workspaces/:id/events` | let agents resume from a cursor |
| `/members`, `/invites`, `/tokens` | manage team and integration access |

Browser calls use the verified user session. Server integrations use `Authorization: Bearer bwk_…`. Private Sites may also require `OAI-Sites-Authorization`; `WorkspaceClient` supports both.

### 6. Add the smallest UI

The target MVP needs a workspace picker/create/join flow, a result list and reader, a preview-before-publish form, a create-fold action, and invitation/integration-key creation.

Reuse `components/team-workspace.tsx` when the target shares this React/Shadcn setup. Otherwise rebuild those five interactions with the target design system and call `WorkspaceClient`. Durable data stays on the server; browser state is temporary UI state.

### 7. Execute

In this repository:

```sh
npm install
npm test
npx tsc --noEmit
npm run build
```

In the target project, run its equivalent migration, test, typecheck, and production-build commands.

## Completion checks

- User A creates a workspace and an editor invitation.
- User B redeems it from another signed-in session.
- User A publishes one `brief.corpus` with a stable idempotency key.
- The same body/key returns the same artifact; a changed body/key returns 409.
- User B reads the same artifact ID and checksum.
- User B creates a `brief.fold` with `parentIds: [corpus.id]`; User A reads it.
- A viewer reads and cannot publish. A non-member cannot discover the workspace.
- A parent from another workspace is rejected.
- A read key reads and cannot publish. A write key publishes a custom kind; revocation blocks its next request.
- An event consumer resumes after `nextAfter`.
- With Gmail enabled, only selected summaries appear in preview and a changed snapshot requires a fresh preview.
- Tests, typecheck, migration inspection, and production build pass.

## Invariants worth keeping

- Artifacts are immutable. A revision is a new artifact pointing to its predecessors.
- `provenance` is caller-declared metadata. The server stamps the real actor.
- Every artifact and parent query includes `workspace_id`.
- Artifact publication and its event commit in one database batch.
- Invitation and integration secrets are returned once, hashed at rest, expiring, and revocable.
- `Idempotency-Key` identifies a logical operation, not one HTTP attempt.
- Built-in `brief.*` kinds are versioned and validated. App namespaces remain JSON-compatible.
- The 256 KiB limit keeps D1 records bounded. Add R2 before accepting large files.
- Gmail credentials remain private to their owner; sharing copies reviewed summaries into a team artifact.

## Example producer

Create a write key in the workspace UI, then run `examples/publish-result.ts` from a trusted server:

```sh
export BRIEF_URL=https://your-site.example
export BRIEF_WORKSPACE_ID=workspace-id
export BRIEF_INTEGRATION_KEY=bwk_secret
npx esbuild examples/publish-result.ts --bundle --platform=node --format=esm --outfile=work/publish-result.mjs
node work/publish-result.mjs
```

Use the source revision plus processor version as the idempotency key. Keep integration and hosting credentials out of browser bundles.

## Future integrations

Fetch provider data in its adapter, convert it to `ArtifactInput`, and call `WorkspaceClient.publish`. Most integrations need no new table or route.

Add a custom validator only when a kind needs stronger guarantees. Add a renderer only when JSON is insufficient for people. Add R2 for large blobs, a queue-backed job table for long model runs, and webhook delivery after the base artifact checks remain green.
