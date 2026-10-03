import {
  CORPUS_KIND,
  type ArtifactInput,
  type Json,
} from '@/lib/workspaces/contracts';
import { HttpError } from '../runtime';
import { selectedIds } from './processors';
import { string } from './validation';
import { parseSnapshot } from '../snapshots';
import { loadMessage } from '../messages';

/**
 * Explicit bridge from a private Gmail snapshot to a shareable corpus. Only summaries the
 * user selected are copied; credentials and full message bodies remain private.
 */
/** Reads only the requesting human's existing snapshot; never shares the Gmail grant. */
export async function gmailPreview(
  db: D1Database,
  userId: string,
  data: Record<string, unknown>,
): Promise<ArtifactInput> {
  const accountId = string(data.accountId, 'Account ID');
  const ids = selectedIds(data.messageIds);
  // Sharing always names one real mailbox. The combined view is not a source of truth,
  // and the snapshot is read with both identifiers so an account id from the browser
  // never grants access to a mailbox the signed-in user does not own.
  if (accountId === 'all')
    throw new HttpError(400, 'Choose one Gmail account before sharing a summary.');
  const row = await db
    .prepare('SELECT data, updated FROM snapshots WHERE account_id = ? AND user_id = ?')
    .bind(accountId, userId)
    .first<{ data: string; updated: number }>();
  if (!row)
    throw new HttpError(404, 'Refresh this Gmail account before sharing.');
  const snapshot = parseSnapshot(row.data);
  if (!snapshot)
    throw new HttpError(409, 'This Gmail cache is damaged. Refresh the mailbox before sharing.');
  const emails = await Promise.all(ids.map(async(id) => {
    // The stored message first: the snapshot keeps only a slim copy without the body.
    const email = await loadMessage(userId,accountId,id,{DB:db} as import('../runtime').Runtime)
      ||snapshot.emails.find((e) => e?.id === id);
    if (!email)
      throw new HttpError(
        409,
        'A selected message is no longer in the snapshot. Refresh your selection.',
      );
    return email;
  }));
  const documents = emails.map((e) => ({
    id: e.id,
    title: e.subject,
    text: e.summary || e.subject,
    source: e.sender,
  }));
  // Byte counts show how much compression occurred without exposing omitted text.
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
