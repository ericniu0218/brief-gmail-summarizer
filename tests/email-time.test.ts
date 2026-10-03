import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receivedLabel } from '../lib/email-time';

/**
 * Arrival times are shown in the reader's zone. The server's preformatted `time` is in the
 * worker's zone (UTC), so it is only a fallback for records without a timestamp.
 */

const AT = Date.UTC(2026, 9, 3, 8, 17); // 01:17 in California, 08:17 UTC
const OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

void test('a timestamped message shows its arrival in the reader\'s zone, not the server\'s text', () => {
  const email = { time: 'Oct 3, 8:17 AM', receivedAt: AT };
  assert.equal(receivedLabel(email, AT + 60000), new Date(AT).toLocaleString('en-US', OPTIONS));
});

void test('before the clock is known a timestamped message shows no time, never the server\'s zone', () => {
  assert.equal(receivedLabel({ time: 'Oct 3, 8:17 AM', receivedAt: AT }, null), '');
});

void test('a record without a usable timestamp keeps its stored text', () => {
  assert.equal(receivedLabel({ time: '7:40 AM' }, AT), '7:40 AM');
  assert.equal(receivedLabel({ time: '7:40 AM', receivedAt: 0 }, null), '7:40 AM');
  assert.equal(receivedLabel({ time: '', receivedAt: Number.NaN }, AT), '');
});
