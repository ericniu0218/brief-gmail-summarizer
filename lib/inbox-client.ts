import type { Email } from './mail';

/** Browser-side transport shared by inbox hooks and controls. */

export type InboxSnapshot = {
  emails: Email[];
  updated: number | null;
  ai: boolean;
  hasMore?: boolean;
  /** Messages Gmail returned but this refresh could not safely read. */
  skipped?: number;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public signInUrl?: string,
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
    );
  return data;
}

/** Show saved mail first, then replace it with the completed Gmail briefing. */
export async function loadConnectedInbox(
  onSnapshot: (snapshot: InboxSnapshot) => void,
  signal?: AbortSignal,
) {
  const cached = await api<InboxSnapshot>('/api/mailbox', undefined, signal);
  onSnapshot(cached);
  const fresh = await api<InboxSnapshot>('/api/sync', {}, signal);
  onSnapshot(fresh);
  return fresh;
}
