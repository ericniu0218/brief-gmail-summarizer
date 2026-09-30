import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { getOwnedConnection } from '@/server/gmail';
import { normalizeSenderAddress } from '@/server/overrides';
import { MAX_BLOCKED_NAME, setBlocked } from '@/server/blocked';

/**
 * Hides, or stops hiding, one sender's mail in one connected account.
 *
 * Nothing is sent anywhere and nothing is deleted: the sender is not told, Gmail is not
 * changed, and every stored message stays in place for when the sender is unblocked.
 */
export async function POST(request: Request) {
  try {
    mutation(request); const user = await userId(); const e = runtime();
    const body = await inputObject(request);
    if (typeof body.blocked !== 'boolean') throw new HttpError(400, 'Choose whether to block or unblock this sender.');
    const address = normalizeSenderAddress(body.address);
    if (!address) throw new HttpError(400, 'Choose a valid sender.');
    // Rejects a foreign account, an unknown id and the combined "All inboxes" selection.
    const owned = await getOwnedConnection(user, typeof body.accountId === 'string' ? body.accountId : '', e);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, MAX_BLOCKED_NAME) : null;
    await setBlocked(user, owned.id, address, name, body.blocked, e);
    return json({ accountId: owned.id, address, blocked: body.blocked });
  } catch (error) { return failure(error); }
}
