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
import { demoEmails, emailKey, type Email } from '../lib/mail';
import { SidebarProvider } from '../components/ui/sidebar';
import { CategoryNav } from '../components/category-nav';
import { PriorityEmailList } from '../components/priority-email-list';
import { buildEmailDocument, EmailBody } from '../components/email-body';
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
  assert.match(html,/class="[^"]*briefing-card/,'the daily brief is present in server HTML');
  assert.match(html,/class="email-list"/,'the inbox list is present in server HTML');
  assert.match(html,/The website launch is ready for your sign-off/,'server HTML contains useful email content');
  assert.doesNotMatch(html,/>0<small>work conversations<\/small>/,
    'server HTML does not temporarily report zero important work conversations');
});

void test('formatted email is sandboxed and remote images require an explicit choice',()=>{
  const source='<base href="https://tracker.example/"><script>top.location="https://bad.example"</script><form action="https://bad.example"><input name="secret"></form><img src="https://images.example/banner.png"><p>Hello</p>';
  const blocked=buildEmailDocument(source);
  assert.match(blocked,/script-src 'none'/);
  assert.match(blocked,/img-src data: blob:/);
  assert.doesNotMatch(blocked,/<script|<form|<input|tracker\.example/);
  const allowed=buildEmailDocument(source,true);
  assert.match(allowed,/img-src https: data: blob:/);
  const email={...demoEmails[0],html:'<p>Formatted message</p>'};
  const markup=renderToStaticMarkup(createElement(EmailBody,{email}));
  // Popups are granted so a reader can follow a link the document sends to a new tab, and
  // the opened page escapes the sandbox so the destination is an ordinary tab rather than
  // an opaque, script-less one. Everything that would let the message act on its own —
  // scripts, same-origin access, forms, top-level navigation — stays withheld, so only a
  // real click can navigate.
  const sandbox=/sandbox="([^"]*)"/.exec(markup)?.[1]??'';
  assert.deepEqual(sandbox.split(' ').sort(),['allow-popups','allow-popups-to-escape-sandbox']);
  for(const denied of ['allow-scripts','allow-same-origin','allow-forms','allow-modals','allow-top-navigation'])
    assert.ok(!sandbox.includes(denied),`${denied} must not be granted`);
  assert.match(markup,/Remote images are blocked/);
  assert.match(markup,/Load images/);
  assert.match(markup,/Always load from this sender/);
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
      now: Date.now(),
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
      now: Date.now(),
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

/** Renders the sidebar navigation inside the provider that supplies its layout context. */
function navMarkup(options: {
  view: string;
  allInboxes: boolean;
  emails?: Email[];
  onSelect?: (view: string) => void;
  onSelectAllInboxes?: () => void;
}) {
  return renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(CategoryNav, {
        emails: options.emails ?? [],
        view: options.view,
        allInboxes: options.allInboxes,
        onSelect: options.onSelect ?? (() => {}),
        onSelectAllInboxes: options.onSelectAllInboxes ?? (() => {}),
      }),
    ),
  );
}

/** A minimal message shaped for list rendering, scoped to one mailbox. */
function listEmail(id: string, accountId: string, accountEmail: string, subject: string) {
  return {
    ...demoEmails[0],
    id,
    accountId,
    accountEmail,
    subject,
    category: 'work',
    tags: [],
  } as unknown as Email;
}

void test('the sidebar offers All inboxes directly above the single-account Inbox', () => {
  const html = navMarkup({ view: 'inbox', allInboxes: true });
  const combined = html.indexOf('All inboxes');
  const single = html.indexOf('>Inbox<');
  assert.ok(combined > -1, 'the combined entry is present in the sidebar');
  assert.ok(single > -1, 'the existing Inbox entry is preserved');
  assert.ok(combined < single, 'All inboxes sits above Inbox');
  // It must be reachable by keyboard, so it stays a real button rather than a div.
  assert.match(
    html,
    /<button\b(?:(?!<\/button>)[\s\S])*All inboxes/,
    'All inboxes is a focusable button element',
  );
});

/**
 * Counts the navigation rows rendered as selected.
 *
 * The rendered class list contains Tailwind variants named `data-active:…`, so only the
 * real `data-active=""` attribute may be counted; matching the bare string would report
 * every row as active.
 */
function activeRows(html: string) {
  return html.split('<button').filter(part => part.split('>')[0].includes('data-active=""'));
}

void test('the combined scope and a single mailbox never look selected at the same time', () => {
  // Combined scope on the top-level inbox: only All inboxes is highlighted.
  const combined = navMarkup({ view: 'inbox', allInboxes: true });
  const combinedRows = activeRows(combined);
  assert.equal(combinedRows.length, 1, 'exactly one navigation row is active');
  assert.ok(combinedRows[0].includes('All inboxes'), 'the active row is All inboxes');

  // A single account on the same view highlights the ordinary Inbox instead.
  const single = navMarkup({ view: 'inbox', allInboxes: false });
  const singleRows = activeRows(single);
  assert.equal(singleRows.length, 1, 'exactly one navigation row is active');
  assert.ok(!singleRows[0].includes('All inboxes'), 'All inboxes is not highlighted');

  // Choosing a category inside the combined scope moves the highlight off All inboxes
  // without implying a single mailbox is selected.
  const category = navMarkup({ view: 'work', allInboxes: true });
  const categoryRows = activeRows(category);
  assert.equal(categoryRows.length, 1, 'exactly one navigation row is active');
  assert.ok(categoryRows[0].includes('Work'), 'the chosen category is highlighted');
});

void test('a combined total is reported only while combined mail is loaded', () => {
  const emails = [
    listEmail('m1', 'acct-1', 'first@example.com', 'From the first mailbox'),
    listEmail('m2', 'acct-2', 'second@example.com', 'From the second mailbox'),
  ];
  const combined = navMarkup({ view: 'inbox', allInboxes: true, emails });
  const row = combined.slice(combined.indexOf('All inboxes'));
  assert.match(row.slice(0, 120), /nav-count/, 'the combined row reports its total');

  // A single-account snapshot cannot describe mailboxes it never read, so the combined
  // row stays unnumbered rather than showing one account's count as if it were the total.
  const single = navMarkup({ view: 'inbox', allInboxes: false, emails });
  const singleRow = single.slice(single.indexOf('All inboxes'));
  assert.ok(
    !singleRow.slice(0, 120).includes('nav-count'),
    'no total is claimed while a single mailbox is in scope',
  );
});

void test('category expand arrows stay separate controls from category navigation', () => {
  const html = navMarkup({ view: 'inbox', allInboxes: true });
  // The arrow is its own button with its own label and disclosure state, so activating it
  // cannot also trigger the parent category's navigation.
  assert.match(html, /class="nav-arrow"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-label="Expand Work subcategories"/);
  assert.match(html, /id="nav-submenu-work"[^>]*hidden/);
  // Noise has no subcategories and therefore offers no arrow.
  assert.ok(!html.includes('Noise subcategories'), 'Noise exposes no disclosure control');
});

void test('the combined list labels each row with the mailbox that received it', () => {
  const emails = [
    listEmail('m1', 'acct-1', 'first@example.com', 'From the first mailbox'),
    listEmail('m2', 'acct-2', 'second@example.com', 'From the second mailbox'),
  ];
  const labelled = renderToStaticMarkup(
    createElement(PriorityEmailList, {
      emails,
      now: Date.now(),
      busy: false,
      showAccount: true,
      emptyTitle: 'All clear.',
      emptyBody: 'Nothing here.',
      onSelect: () => {},
    }),
  );
  assert.ok(labelled.includes('first@example.com'), 'the first mailbox is identified');
  assert.ok(labelled.includes('second@example.com'), 'the second mailbox is identified');

  // A single-account view keeps its existing layout with no redundant label.
  const plain = renderToStaticMarkup(
    createElement(PriorityEmailList, {
      emails,
      now: Date.now(),
      busy: false,
      emptyTitle: 'All clear.',
      emptyBody: 'Nothing here.',
      onSelect: () => {},
    }),
  );
  assert.ok(!plain.includes('email-account'), 'no account label in the single-account layout');
});

void test('messages sharing a Gmail id in different mailboxes both stay visible', () => {
  // Gmail ids are unique per mailbox, not across mailboxes. Keying rows by the raw id
  // would make React treat these as one row and drop the second message.
  const emails = [
    listEmail('shared-id', 'acct-1', 'first@example.com', 'Invoice for the first mailbox'),
    listEmail('shared-id', 'acct-2', 'second@example.com', 'Invoice for the second mailbox'),
  ];
  assert.notEqual(emailKey(emails[0]), emailKey(emails[1]), 'composite identities differ');
  const html = renderToStaticMarkup(
    createElement(PriorityEmailList, {
      emails,
      now: Date.now(),
      busy: false,
      showAccount: true,
      emptyTitle: 'All clear.',
      emptyBody: 'Nothing here.',
      onSelect: () => {},
    }),
  );
  assert.ok(html.includes('Invoice for the first mailbox'), 'the first message renders');
  assert.ok(html.includes('Invoice for the second mailbox'), 'the second message renders');
});

void test('a view restored on load opens the groups that contain it', () => {
  // Nothing has been clicked here: this is the first render after a remembered
  // subcategory is restored. Both levels must already be open, or the highlighted row
  // would be sealed inside a collapsed group with nothing appearing selected.
  const restored = navMarkup({ view: 'work:deadlines', allInboxes: false });
  assert.match(
    restored,
    /id="nav-submenu-sections"(?![^>]*hidden)/,
    'the section group is open',
  );
  assert.match(
    restored,
    /id="nav-submenu-work"(?![^>]*hidden)/,
    'and so is the subcategory it belongs to',
  );
  assert.equal(activeRows(restored).length, 0, 'no section row claims the selection');
  assert.match(restored, /nav-subitem[^>]*data-active[^>]*>\s*<span>Deadlines/, 'the subcategory is current');

  // A plain top-level view leaves both closed, which is what keeps the sidebar quiet.
  const plain = navMarkup({ view: 'inbox', allInboxes: false });
  assert.match(plain, /id="nav-submenu-sections"[^>]*hidden/, 'the group rests closed');
  assert.match(plain, /id="nav-submenu-work"[^>]*hidden/, 'and so do the subcategories');
});

void test('links in a formatted email are followable, and unsafe schemes are not', () => {
  const html = [
    '<a href="https://vendor.example/order">Order now</a>',
    '<a href="http://plain.example">Plain</a>',
    '<a href="mailto:someone@example.com">Mail</a>',
    '<a href="javascript:alert(1)">Script</a>',
    '<a href="  java\nscript:alert(1)  ">Obfuscated</a>',
    '<a href="data:text/html,<b>x</b>">Data</a>',
    '<a href=\'vbscript:msgbox(1)\'>VB</a>',
    '<a href=/relative/path>Relative</a>',
  ].join('');
  const document = buildEmailDocument(html);
  // A real destination survives, so "Order now" and verification links actually go somewhere.
  assert.match(document, /href="https:\/\/vendor\.example\/order"/);
  assert.match(document, /href="http:\/\/plain\.example"/);
  assert.match(document, /href="mailto:someone@example\.com"/);
  // Everything else loses its href and stays as inert text rather than a live link.
  assert.doesNotMatch(document, /javascript:/i);
  assert.doesNotMatch(document, /vbscript:/i);
  assert.doesNotMatch(document, /href="data:/i);
  assert.doesNotMatch(document, /href=\/relative/i);
  // The link text is still readable; only the destination was removed.
  for (const label of ['Script', 'Obfuscated', 'Data', 'VB', 'Relative'])
    assert.ok(document.includes(label), `${label} is still shown as text`);
  // Links still open away from the application rather than inside the reading panel.
  assert.match(document, /<base href="about:blank" target="_blank">/);
});
