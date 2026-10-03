import type { Email } from './mail';

/**
 * When a message arrived, in the reader's own time zone.
 *
 * `email.time` is formatted once on the server, in the server's zone (UTC on the worker),
 * so it is only the fallback for records without a timestamp, such as the sample workspace.
 * `now` is the dashboard clock: while it is still null (the server render and the first
 * paint) a timestamped message shows no time rather than the server's, so the two renders
 * agree and a wrong hour never flashes up before the right one.
 */
export function receivedLabel(email: Pick<Email, 'time' | 'receivedAt'>, now: number | null): string {
  const at = email?.receivedAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return email?.time || '';
  if (now === null) return '';
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
