/** Server-side integration example. No provider credential is sent to Brief. */
import { WorkspaceClient } from '../lib/workspaces/client';
const {
  BRIEF_URL,
  BRIEF_WORKSPACE_ID,
  BRIEF_INTEGRATION_KEY,
  BRIEF_SITES_BYPASS_TOKEN,
} = process.env;
if (!BRIEF_URL || !BRIEF_WORKSPACE_ID || !BRIEF_INTEGRATION_KEY)
  throw new Error(
    'Set BRIEF_URL, BRIEF_WORKSPACE_ID and BRIEF_INTEGRATION_KEY.',
  );
const client = new WorkspaceClient({
  baseUrl: BRIEF_URL,
  token: BRIEF_INTEGRATION_KEY,
  sitesAuthorization: BRIEF_SITES_BYPASS_TOKEN,
});

// An external app owns extraction and analysis. Brief owns durable team access.
// Use your real immutable source revision as the retry key; do not use Date.now().
const sourceRevision = 'demo-project-2026-09-14-v1';
const result = await client.publish(
  BRIEF_WORKSPACE_ID,
  {
    kind: 'example.project_analysis',
    schemaVersion: 1,
    title: 'Example project analysis',
    summary:
      'Illustrative integration result; replace with your app’s real output.',
    content: {
      findings: [
        { text: 'Example: approval is pending.', sourceId: 'example-task-123' },
      ],
      status: 'sample',
    },
    provenance: {
      adapter: 'example',
      processor: 'example-analysis-v1',
      sourceRevision,
    },
    parentIds: [],
  },
  `example:${sourceRevision}`,
);
console.log(
  JSON.stringify({
    id: result.artifact.id,
    replayed: result.replayed,
    checksum: result.artifact.checksum,
  }),
);
const sameResult = await client.get(BRIEF_WORKSPACE_ID, result.artifact.id);
if (sameResult.checksum !== result.artifact.checksum)
  throw new Error('Unexpected stored content checksum.');
