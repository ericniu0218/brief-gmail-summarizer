import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Dashboard from '../app/page';
import { ConnectGmailButton } from '../components/connect-gmail-button';
import { GmailSetupNote } from '../components/connection-panel';
import { DailyBrief } from '../components/daily-brief';
import { resolveSelection, requestGate, type ConnectionStatus } from '../hooks/use-inbox';
import { AccountList } from '../components/connection-panel';
import { demoEmails } from '../lib/mail';
import {
  api,
  ApiError,
  loadConnectedInbox,
  type InboxSnapshot,
} from '../lib/inbox-client';

const status: ConnectionStatus = {
  accounts: [],
  defaultAccountId: null,
  connected: false,
  configured: true,
  aiConfigured: true,
  schedulerActive: false,
  intervalMinutes: 30,
};

void test('the dashboard exposes Connect Gmail without opening settings', () => {
  const html = renderToStaticMarkup(createElement(Dashboard));
  assert.ok(
    /<(?:a|button)\b[^>]*>(?:(?!<\/(?:a|button)>)[\s\S])*Connect Gmail<\/(?:a|button)>/.test(
      html,
    ),
    'The initial dashboard must contain a visible Connect Gmail action',
  );
});

void test('Connect Gmail uses a top-level OAuth navigation and resumes after platform sign-in', () => {
  const ready = renderToStaticMarkup(
    createElement(ConnectGmailButton, { status, onSetup: () => {} }),
  );
  assert.match(ready, /href="\/api\/auth\/google"/);
  assert.match(ready, /target="_top"/);
  const signedOut = renderToStaticMarkup(
    createElement(ConnectGmailButton, {
      status: null,
      signInUrl: '/signin-with-chatgpt?return_to=%2F',
      onSetup: () => {},
    }),
  );
  assert.match(
    signedOut,
    /href="\/signin-with-chatgpt\?return_to=%2Fapi%2Fauth%2Fgoogle"/,
  );
});

void test('the daily brief displays personal Gmail summaries without requiring work-category mail', () => {
  const email = {
    ...demoEmails[5],
    id: 'real-mail',
    subject: 'Family dinner',
    summary: 'Please confirm whether you can attend dinner.',
    category: 'personal' as const,
  };
  const html = renderToStaticMarkup(
    createElement(DailyBrief, {
      emails: [email],
      connected: true,
      ai: true,
      aiConfigured: true,
      busy: false,
      updated: Date.now(),
      collapsed: false,
      onCollapse: () => {},
      onSelect: () => {},
    }),
  );
  assert.match(html, /Please confirm whether you can attend dinner/);
  assert.match(html, /AI SUMMARY/);
  assert.doesNotMatch(html, /website launch|SAMPLE BRIEF|Sarah needs/);
});

void test('the first Gmail sync displays progress instead of claiming the inbox is empty or caught up', () => {
  const html = renderToStaticMarkup(
    createElement(DailyBrief, {
      emails: [],
      connected: true,
      ai: false,
      aiConfigured: true,
      busy: true,
      updated: null,
      collapsed: false,
      onCollapse: () => {},
      onSelect: () => {},
    }),
  );
  assert.match(html, /Reading your Gmail and preparing your first summary/);
  assert.doesNotMatch(html, /inbox is empty|all caught up|SAMPLE BRIEF/);
});

void test('a slow cached mailbox response finishes before the fresh summary is requested and displayed', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const seen: InboxSnapshot[] = [];
  const cached: InboxSnapshot = { emails: [], updated: null, ai: false };
  const fresh: InboxSnapshot = {
    emails: [demoEmails[5]],
    updated: 123,
    ai: true,
  };
  let finishCache!: (response: Response) => void;
  globalThis.fetch = async (input) => {
    const path = input instanceof Request ? input.url : input.toString();
    requests.push(path);
    if (path === '/api/mailbox')
      return new Promise<Response>((resolve) => {
        finishCache = resolve;
      });
    assert.equal(path, '/api/sync');
    return Response.json(fresh);
  };
  try {
    const pending = loadConnectedInbox((snapshot) => seen.push(snapshot));
    assert.deepEqual(requests, ['/api/mailbox']);
    finishCache(Response.json(cached));
    await pending;
    assert.deepEqual(requests, ['/api/mailbox', '/api/sync']);
    assert.deepEqual(seen, JSON.parse(JSON.stringify([cached, fresh])));
  } finally {
    globalThis.fetch = original;
  }
});

void test('a non-JSON platform error page becomes a readable inbox error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<!DOCTYPE html><title>Worker exceeded time limit</title>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });
  try {
    await assert.rejects(api('/api/sync', {}), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.doesNotMatch(error.message, /JSON|Unexpected token|DOCTYPE/);
      assert.match(error.message, /503|try again/i);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

void test('the setup notice lists exactly which site settings are missing', () => {
  const html = renderToStaticMarkup(
    createElement(GmailSetupNote, {
      status: {
        ...status,
        configured: false,
        missingSettings: ['TOKEN_ENCRYPTION_KEY'],
        callbackUrl: 'https://brief.example/api/auth/google/callback',
      },
    }),
  );
  assert.match(html, /TOKEN_ENCRYPTION_KEY/);
  assert.match(html, /https:\/\/brief\.example\/api\/auth\/google\/callback/);
});

// ── Multi-account selection and stale-response protection ───────────────────

void test('a remembered selection is restored only while the user still owns it', () => {
  const accounts = [{ id: 'acct-1' }, { id: 'acct-2' }];
  assert.equal(resolveSelection('acct-2', accounts, 'acct-1'), 'acct-2');
  assert.equal(resolveSelection('all', accounts, 'acct-1'), 'all');
  // A mailbox that was disconnected, or one belonging to somebody else, is not restored.
  assert.equal(resolveSelection('acct-gone', accounts, 'acct-1'), 'acct-1');
  assert.equal(resolveSelection('acct-b', accounts, null), 'acct-1');
  // Nothing remembered and no default still lands on a mailbox the user owns.
  assert.equal(resolveSelection(null, accounts, null), 'acct-1');
  // With no accounts at all the combined view is the only sensible destination.
  assert.equal(resolveSelection('acct-1', [], null), 'all');
  // A stale default that no longer exists does not win over a valid remembered account.
  assert.equal(resolveSelection('acct-2', accounts, 'acct-gone'), 'acct-2');
});

void test('a late response for a previous mailbox cannot overwrite the current one', async () => {
  const gate = requestGate();
  const painted: string[] = [];
  // Two overlapping loads: the first mailbox is slow, the second resolves immediately.
  const slow = (async () => {
    const ticket = gate.begin();
    await new Promise((r) => setTimeout(r, 20));
    if (gate.isCurrent(ticket)) painted.push('acct-1');
  })();
  const fast = (async () => {
    const ticket = gate.begin();
    if (gate.isCurrent(ticket)) painted.push('acct-2');
  })();
  await Promise.all([slow, fast]);
  assert.deepEqual(
    painted,
    ['acct-2'],
    'only the mailbox the user switched to may paint',
  );
});

void test('switching away and back keeps the newest selection authoritative', async () => {
  const gate = requestGate();
  const first = gate.begin();
  const second = gate.begin();
  const third = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.isCurrent(third), true, 'the newest switch wins');
});

void test('the settings list shows every mailbox with its own actions', () => {
  const html = renderToStaticMarkup(
    createElement(AccountList, {
      accounts: [
        { id: 'acct-1', email: 'first@example.com', lastSync: 1789000000000, error: null },
        { id: 'acct-2', email: 'second@example.com', lastSync: null, error: 'Reconnect Gmail', reconnectRequired: true },
      ],
      defaultAccountId: 'acct-1',
      onSetDefault: async () => {},
      onDisconnectAccount: async () => {},
    }),
  );
  assert.ok(html.includes('first@example.com'), 'lists the first mailbox');
  assert.ok(html.includes('second@example.com'), 'lists the second mailbox');
  assert.ok(html.includes('Default'), 'marks the default account');
  assert.ok(html.includes('Needs reconnection'), 'shows the failing account status');
  // Reconnect is aimed at the account that needs it, not a generic flow.
  assert.ok(
    html.includes('action=reconnect&amp;accountId=acct-2'),
    'reconnect targets the failing account',
  );
  assert.ok(!html.includes('accountId=acct-1&amp;'), 'the healthy account offers no reconnect');
  assert.ok(html.includes('action=add'), 'offers adding another mailbox');
  assert.ok(html.includes('Set as default'), 'offers promoting the non-default account');
  assert.ok(html.includes('Disconnect'), 'offers per-account disconnect');
});
