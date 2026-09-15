import type { Email } from '@/lib/mail';
import {
  CORPUS_KIND,
  type ArtifactInput,
  type Json,
} from '@/lib/workspaces/contracts';
import { HttpError } from '../runtime';
import { selectedIds } from './processors';
import { string } from './validation';
/** Reads only the requesting human's existing snapshot; never shares the Gmail grant. */
export async function gmailPreview(
  db: D1Database,
  userId: string,
  data: Record<string, unknown>,
): Promise<ArtifactInput> {
  const accountId = string(data.accountId, 'Account ID');
  const ids = selectedIds(data.messageIds);
  if (accountId !== 'default')
    throw new HttpError(
      400,
      'The current Gmail adapter supports the default connected account.',
    );
  const row = await db
    .prepare('SELECT data, updated FROM snapshots WHERE user_id = ?')
    .bind(userId)
    .first<{ data: string; updated: number }>();
  if (!row)
    throw new HttpError(404, 'Refresh this Gmail account before sharing.');
  const snapshot = JSON.parse(row.data) as { emails: Email[]; ai?: boolean };
  const emails = ids.map((id) => {
    const email = snapshot.emails.find((e) => e.id === id);
    if (!email)
      throw new HttpError(
        409,
        'A selected message is no longer in the snapshot. Refresh your selection.',
      );
    return email;
  });
  const documents = emails.map((e) => ({
    id: e.id,
    title: e.subject,
    text: e.summary || e.subject,
    source: e.sender,
  }));
  const byteLength = (value: string) =>
    new TextEncoder().encode(value).byteLength;
  return {
    kind: CORPUS_KIND,
    schemaVersion: 1,
    title: string(data.title, 'Title'),
    summary: `${documents.length} selected Gmail summaries.`,
    content: {
      documents: documents as unknown as Json,
      method: snapshot.ai ? 'cached-ai-summaries' : 'cached-extracts',
      originalBytes: byteLength(emails.map((e) => e.body).join('\n\n')),
      storedTextBytes: byteLength(documents.map((d) => d.text).join('\n\n')),
    },
    provenance: {
      adapter: 'gmail',
      snapshotUpdated: row.updated,
      selectionCount: ids.length,
      lossy: true,
    },
    parentIds: [],
  };
}
