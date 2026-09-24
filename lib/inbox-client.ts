import type { Email } from './mail';

/** Browser-side transport shared by inbox hooks and controls. */

/** One connected mailbox's contribution to a view, reported even when it failed to load. */
export type InboxAccountState = {
  id: string;
  email: string;
  lastSync: number | null;
  error: string | null;
  loaded: boolean;
  pending: number;
  skipped: number;
  hasMore: boolean;
};
export type InboxSnapshot = {
  emails: Email[];
  updated: number | null;
  ai: boolean;
  hasMore?: boolean;
  /** Messages Gmail returned but this refresh could not safely read. */
  skipped?: number;
  pending?: number;
  /**
   * Per-account state for the current selection. The combined view lists every connected
   * mailbox, so a caller can tell which accounts loaded and which need attention rather
   * than treating a partial result as complete.
   */
  accounts?: InboxAccountState[];
  /** Set only on a refresh response: how many accounts refreshed or failed. */
  refreshed?: number;
  failed?: number;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public signInUrl?: string,
    public status?: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  // The presence of a body determines whether this small client sends GET or POST.
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  // Platform timeouts and gateway errors arrive as HTML, not the API's JSON.
  const data = (await response.json().catch(() => {
    if (response.ok)
      throw new ApiError('The server sent an unreadable response. Please try again.');
    return {};
  })) as T & {
    error?: string;
    signInUrl?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ||
        `That request could not be completed (error ${response.status}). Please try again.`,
      data.signInUrl === '/signin-with-chatgpt?return_to=%2F'
        ? data.signInUrl
        : undefined,
      response.status,
    );
  return data;
}

/**
 * Show saved mail first, then replace it with the completed Gmail briefing.
 *
 * `accountId` selects one mailbox; omitting it loads the combined view across every
 * connected account. The same selection is used for both requests, so the refreshed
 * result always describes the mailbox the cached result came from.
 */
export async function loadConnectedInbox(
  onSnapshot: (snapshot: InboxSnapshot) => void,
  signal?: AbortSignal,
  accountId?: string,
) {
  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  const cached = await api<InboxSnapshot>(`/api/mailbox${query}`, undefined, signal);
  onSnapshot(cached);
  // The sync response already carries the refreshed view, so one round trip is enough.
  const fresh = await api<InboxSnapshot>('/api/sync', accountId ? { accountId } : {}, signal);
  onSnapshot(fresh);
  return fresh;
}
