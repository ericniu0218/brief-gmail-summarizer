import { normalizeSenderAddress } from './overrides';
import type { Runtime } from './runtime';

/**
 * Senders hidden from one connected account's views.
 *
 * This is read-time filtering only. Sync still stores every message and nothing is removed
 * from Gmail, so unblocking restores the sender's mail exactly as it was.
 */
export type BlockedSender = { accountId: string; address: string; name: string | null; created: number };

export const MAX_BLOCKED_NAME = 200;

export async function loadBlockedSenders(user: string, accountId: string, e: Runtime) {
  const rows = await e.DB.prepare(
    'SELECT account_id, address, name, created FROM blocked_senders WHERE account_id=? AND user_id=? ORDER BY created DESC, address')
    .bind(accountId, user).all<{ account_id: string; address: string; name: string | null; created: number }>();
  return (rows.results || []).map((row): BlockedSender =>
    ({ accountId: row.account_id, address: row.address, name: row.name, created: row.created }));
}

/** Whether a message's sender is in the blocked set, compared the way rules compare. */
export function isBlocked(blocked: Set<string>, address: unknown) {
  const normalized = normalizeSenderAddress(address);
  return !!normalized && blocked.has(normalized);
}

/**
 * Block or unblock one sender in one account. The insert names the connection in the same
 * statement, so a block cannot be written for an account disconnected a moment earlier.
 */
export async function setBlocked(user: string, accountId: string, address: string, name: string | null,
  blocked: boolean, e: Runtime) {
  if (blocked) {
    await e.DB.prepare(`INSERT INTO blocked_senders (user_id,account_id,address,name,created)
        SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=?)
      ON CONFLICT(account_id,address) DO NOTHING`)
      .bind(user, accountId, address, name, Date.now(), accountId, user).run();
  } else {
    await e.DB.prepare('DELETE FROM blocked_senders WHERE account_id=? AND user_id=? AND address=?')
      .bind(accountId, user, address).run();
  }
}
