'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  FileStack,
  KeyRound,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ArtifactContent } from './artifact-content';
import { WorkspaceApiError, WorkspaceClient } from '@/lib/workspaces/client';
import {
  CORPUS_KIND,
  type Artifact,
  type ArtifactInput,
  type ArtifactSummary,
  type JoinCode,
  type Member,
  type Workspace,
  type WorkspaceEvent,
} from '@/lib/workspaces/contracts';
const api = new WorkspaceClient();
type Invite = {
  id: string;
  role: string;
  expires: number;
  usedBy: string | null;
  revoked: number | null;
};
type Integration = {
  id: string;
  name: string;
  scope: string;
  expires: number;
  revoked: number | null;
};
const date = (n: number) => new Date(n).toLocaleString();
const kindName = (kind: string) =>
  kind === 'brief.corpus'
    ? 'Compressed corpus'
    : kind === 'brief.fold'
      ? 'Fold result'
      : kind;

/**
 * Complete team workspace screen: choose or join a workspace, browse immutable results,
 * publish new corpora, inspect activity, and let owners manage people and integrations.
 */
export function TeamWorkspace() {
  // Workspace selection, result browsing, and administration share this page but remain
  // separate state groups so changing one tab does not discard unrelated work.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [signIn, setSignIn] = useState('');
  const [name, setName] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [tab, setTab] = useState('results');
  const [publishMode, setPublishMode] = useState('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ArtifactInput | null>(null);
  const publishKey = useRef('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteLink, setInviteLink] = useState('');
  const [joinCode, setJoinCode] = useState<JoinCode | null>(null);
  const [codeRole, setCodeRole] = useState('editor');
  const [integrationName, setIntegrationName] = useState('');
  const [scope, setScope] = useState('read');
  const [newKey, setNewKey] = useState('');
  const active = workspaces.find((w) => w.id === workspaceId);
  const owner = active?.role === 'owner';
  const canWrite = !!active && active.role !== 'viewer';
  const base = `workspaces/${encodeURIComponent(workspaceId)}`;
  const selection = useRef('');
  const [clockNow, setClockNow] = useState(() => Date.now());
  const fail = useCallback((error: unknown) => {
    setNotice(error instanceof Error ? error.message : 'Something went wrong.');
    if (error instanceof WorkspaceApiError && error.signInUrl)
      setSignIn(error.signInUrl);
  }, []);
  async function act(fn: () => Promise<void>) {
    // All button actions use the same busy and error lifecycle.
    setBusy(true);
    setNotice('');
    try {
      await fn();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }
  const selectWorkspace = useCallback((id: string) => {
    // Clear records owned by the previous workspace before updating the deep link.
    selection.current = id;
    setWorkspaceId(id);
    setItems([]);
    setSelected(null);
    setMembers([]);
    setEvents([]);
    setInvites([]);
    setIntegrations([]);
    setPreview(null);
    setInviteLink('');
    setJoinCode(null);
    setNewKey('');
    setCursor(null);
    setTab('results');
    const params = new URLSearchParams(location.search);
    if (params.get('workspace') !== id) params.delete('artifact');
    params.set('workspace', id);
    history.replaceState(null, '', `/team?${params}`);
  }, []);
  const applyWorkspaces = useCallback(
    (result: { items: Workspace[] }, preferred?: string) => {
      setWorkspaces(result.items);
      setSignIn('');
      const candidate = preferred || selection.current;
      const next = result.items.some((w) => w.id === candidate)
        ? candidate
        : (result.items[0]?.id ?? '');
      if (next !== selection.current) selectWorkspace(next);
    },
    [selectWorkspace],
  );
  async function loadWorkspaces(preferred?: string) {
    applyWorkspaces(
      await api.request<{ items: Workspace[] }>('workspaces'),
      preferred,
    );
  }
  useEffect(() => {
    // Initial load also consumes an invite from the URL fragment. Fragments are never sent
    // to the server and are removed immediately so the secret is not left in browser history.
    const params = new URLSearchParams(location.search);
    const token = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (token)
      history.replaceState(null, '', location.pathname + location.search);
    let cancelled = false;
    void api
      .request<{ items: Workspace[] }>('workspaces')
      .then((result) => {
        if (!cancelled)
          applyWorkspaces(result, params.get('workspace') ?? undefined);
      })
      .catch((error) => {
        if (!cancelled) fail(error);
      })
      .finally(() => {
        if (!cancelled) {
          if (token) setJoinToken(token);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyWorkspaces, fail]);
  useEffect(() => {
    if (!workspaceId) return;
    // Search results, members, and recent activity refresh together. Abort and selection
    // checks keep a slow response from an old workspace out of the current one.
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const params = new URLSearchParams({ q: query, kind });
        const [results, people, activity] = await Promise.all([
          api.request<{ items: ArtifactSummary[]; nextCursor: string | null }>(
            `${base}/artifacts?${params}`,
            { signal: controller.signal },
          ),
          api.request<{ items: Member[] }>(`${base}/members`, {
            signal: controller.signal,
          }),
          // The activity UI uses the latest window; integration consumers use ascending cursors.
          api.request<{ items: WorkspaceEvent[] }>(
            `${base}/events?latest=true&limit=100`,
            { signal: controller.signal },
          ),
        ]);
        if (!controller.signal.aborted) {
          setClockNow(Date.now());
          setItems(results.items);
          setCursor(results.nextCursor);
          setMembers(people.items);
          setEvents(activity.items);
        }
      } catch (error) {
        if (!controller.signal.aborted) fail(error);
      } finally {
        running = false;
      }
    };
    const timer = setTimeout(() => void refresh(), 200);
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('focus', focus);
    };
  }, [workspaceId, base, query, kind, fail]);
  useEffect(() => {
    // Owner-only secrets are loaded only while an administrative tab is open.
    if (!owner || !workspaceId || (tab !== 'people' && tab !== 'integrations'))
      return;
    let cancelled = false;
    void Promise.all([
      api.request<{ items: Invite[] }>(`${base}/invites`),
      api.request<{ items: Integration[] }>(`${base}/tokens`),
      api.request<{ code: JoinCode | null }>(`${base}/code`),
    ])
      .then(([i, t, c]) => {
        if (!cancelled) {
          setInvites(i.items);
          setIntegrations(t.items);
          setJoinCode(c.code);
        }
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [owner, workspaceId, base, tab, fail]);
  async function refresh() {
    const ws = workspaceId;
    const results = await api.list(ws, new URLSearchParams({ q: query, kind }));
    if (selection.current === ws) {
      setItems(results.items);
      setCursor(results.nextCursor);
    }
  }
  async function open(id: string) {
    const ws = workspaceId;
    const result = await api.get(ws, id);
    if (selection.current === ws) setSelected(result);
  }
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setNotice('Copied.');
  }
  async function published(result: { artifact: Artifact }) {
    if (selection.current !== result.artifact.workspaceId) return;
    setPreview(null);
    setText('');
    setTitle('');
    setSelected(result.artifact);
    setTab('results');
    await refresh();
    setNotice('Saved for everyone in this workspace.');
  }
  return (
    <main className="team-shell">
      <header className="team-topbar">
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Layers3 size={22} />
          </span>
          brief<span className="brand-dot">.</span>
        </Link>
        <Link href="/" className="team-back">
          <ArrowLeft size={16} /> Personal inbox
        </Link>
        <span className="team-cloud">
          <span /> Shared in the cloud
        </span>
      </header>
      <div className="team-layout">
        <aside className="team-sidebar">
          <div className="team-section-label">TEAM WORKSPACES</div>
          {workspaces.map((w) => (
            <button
              disabled={busy}
              key={w.id}
              className={`team-workspace-button ${w.id === workspaceId ? 'active' : ''}`}
              onClick={() => selectWorkspace(w.id)}
            >
              <Users size={17} />
              <span>
                {w.name}
                <small>{w.role}</small>
              </span>
            </button>
          ))}
          <form
            className="team-form compact"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const w = await api.request<Workspace>('workspaces', {
                  method: 'POST',
                  body: JSON.stringify({ name }),
                });
                await loadWorkspaces(w.id);
                setName('');
              });
            }}
          >
            <label htmlFor="workspace-name">New workspace</label>
            <Input
              id="workspace-name"
              value={name}
              maxLength={80}
              required
              placeholder="e.g. Product team"
              onChange={(e) => setName(e.target.value)}
            />
            <Button disabled={busy || !!signIn} variant="outline" type="submit">
              <Plus size={15} /> Create workspace
            </Button>
          </form>
          <form
            className="team-form compact"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                // One field takes both a reusable group code and a single-use invitation
                // link; the server decides which was given.
                const result = await api.request<{
                  workspaceId: string;
                  joined: boolean;
                }>('join', {
                  method: 'POST',
                  body: JSON.stringify({ token: joinToken }),
                });
                await loadWorkspaces(result.workspaceId);
                setJoinToken('');
                setNotice(
                  result.joined
                    ? 'You joined the workspace.'
                    : 'You are already a member of this workspace.',
                );
              });
            }}
          >
            <label htmlFor="join-token">Have a group code?</label>
            <Input
              id="join-token"
              value={joinToken}
              required
              maxLength={120}
              placeholder="e.g. ABCD-2345"
              onChange={(e) => setJoinToken(e.target.value)}
            />
            {/* Without an explicit type this renders as type="button", which leaves the
                form submittable only by pressing Enter in the field. */}
            <Button variant="outline" type="submit" disabled={busy || !!signIn}>
              Join workspace
            </Button>
          </form>
          <p className="team-sidebar-note">
            Saved results belong to the team. Open them from any signed-in
            device.
          </p>
        </aside>
        <section className="team-main">
          {notice && (
            <output className="team-notice">
              {notice}
              {signIn && (
                <a href={signIn} target="_top">
                  Sign in with ChatGPT <ArrowUpRight size={14} />
                </a>
              )}
              <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
                ×
              </button>
            </output>
          )}
          <div className="team-heading">
            <div>
              <div className="team-section-label">SHARED KNOWLEDGE</div>
              <h1>{active?.name ?? 'Your team’s work, together.'}</h1>
              <p>
                {active
                  ? 'One library for compressed corpora, folds, and whatever comes next.'
                  : 'Create a workspace or use an invitation to start collaborating.'}
              </p>
            </div>
            {active && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(refresh)}
              >
                <RefreshCw size={16} /> Refresh
              </Button>
            )}
          </div>
          {loading ? (
            <output>Loading your workspaces…</output>
          ) : !active ? (
            <div className="team-empty">
              <Users size={36} />
              <h2>A shared place to build on.</h2>
              <p>
                Save a corpus once. Let a colleague read it, create a fold, and
                leave a result the whole team can reuse.
              </p>
              {signIn && (
                <a className="button" href={signIn} target="_top">
                  Sign in to begin
                </a>
              )}
            </div>
          ) : (
            <>
              <div className="team-stats">
                <span>
                  <FileStack size={18} />
                  <strong>
                    {items.length}
                    {cursor ? '+' : ''}
                  </strong>{' '}
                  visible results
                </span>
                <span>
                  <Users size={18} />
                  <strong>{members.length}</strong> members
                </span>
                <span>
                  <Check size={18} /> Saved centrally · refreshes every 15s
                </span>
              </div>
              <Tabs
                value={tab}
                onValueChange={(value) => setTab(String(value))}
              >
                <TabsList className="team-tabs">
                  <TabsTrigger value="results">Results</TabsTrigger>
                  <TabsTrigger value="publish" disabled={!canWrite}>
                    Publish
                  </TabsTrigger>
                  <TabsTrigger value="people">People</TabsTrigger>
                  {owner && (
                    <TabsTrigger value="integrations">Integrations</TabsTrigger>
                  )}
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                </TabsList>
                <TabsContent value="results">
                  <div className="team-toolbar">
                    <div className="team-search">
                      <Search size={16} />
                      <Input
                        aria-label="Search shared results"
                        value={query}
                        placeholder="Search titles and summaries"
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    <NativeSelect
                      aria-label="Result type"
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      <option value="">All results</option>
                      <option value="brief.corpus">Compressed corpora</option>
                      <option value="brief.fold">Fold results</option>
                    </NativeSelect>
                    {canWrite && (
                      <Button onClick={() => setTab('publish')}>
                        <Plus size={16} /> Publish result
                      </Button>
                    )}
                  </div>
                  {!items.length ? (
                    <div className="team-empty">
                      <FileStack size={32} />
                      <h2>
                        {query || kind
                          ? 'No matching results.'
                          : 'The library is ready for your first result.'}
                      </h2>
                      <p>
                        {query || kind
                          ? 'Try another search or result type.'
                          : 'Publish a text corpus here, or share selected summaries from your personal inbox.'}
                      </p>
                    </div>
                  ) : (
                    <div className="team-results">
                      {items.map((item) => (
                        <button
                          key={item.id}
                          className="team-result"
                          aria-label={`Open ${item.title}`}
                          onClick={() => void act(() => open(item.id))}
                        >
                          <div>
                            <span
                              className={`team-kind ${item.kind === CORPUS_KIND ? 'corpus' : ''}`}
                            >
                              <FileStack size={14} />
                              {kindName(item.kind)}
                            </span>
                            <h2>{item.title}</h2>
                            <p>{item.summary}</p>
                          </div>
                          <footer>
                            <span>
                              {item.authorName} · {date(item.created)}
                            </span>
                            <span>
                              {item.parentIds.length
                                ? `${item.parentIds.length} source result`
                                : 'Original result'}{' '}
                              <ArrowUpRight size={14} />
                            </span>
                          </footer>
                        </button>
                      ))}
                    </div>
                  )}
                  {cursor && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const ws = workspaceId;
                          const page = await api.list(
                            ws,
                            new URLSearchParams({ q: query, kind, cursor }),
                          );
                          if (selection.current === ws) {
                            setItems((previous) => [
                              ...new Map(
                                [...previous, ...page.items].map((item) => [
                                  item.id,
                                  item,
                                ]),
                              ).values(),
                            ]);
                            setCursor(page.nextCursor);
                          }
                        })
                      }
                    >
                      Load more results
                    </Button>
                  )}
                </TabsContent>
                <TabsContent value="publish">
                  <div className="team-panel">
                    <h2>Publish to {active.name}</h2>
                    <p>
                      Everyone in this workspace can read the saved result.
                      Review the exact content before publishing.
                    </p>
                    <div className="team-form">
                      <label htmlFor="publish-mode">Source</label>
                      <NativeSelect
                        id="publish-mode"
                        value={publishMode}
                        onChange={(e) => {
                          setPublishMode(e.target.value);
                          setPreview(null);
                        }}
                      >
                        <option value="text">Text → compressed corpus</option>
                        <option value="json">Integration result JSON</option>
                      </NativeSelect>
                      {publishMode === 'text' && (
                        <>
                          <label htmlFor="result-title">Title</label>
                          <Input
                            id="result-title"
                            value={title}
                            maxLength={160}
                            onChange={(e) => {
                              setTitle(e.target.value);
                              setPreview(null);
                            }}
                            placeholder="e.g. Launch research · September"
                          />
                        </>
                      )}
                      <label htmlFor="result-text">
                        {publishMode === 'text'
                          ? 'Source text · separate documents with blank lines'
                          : 'Full artifact JSON · kind, schemaVersion, title, summary, content, provenance, parentIds'}
                      </label>
                      <Textarea
                        id="result-text"
                        rows={10}
                        value={text}
                        onChange={(e) => {
                          setText(e.target.value);
                          setPreview(null);
                        }}
                        placeholder={
                          publishMode === 'text'
                            ? 'Paste the material you want to share…'
                            : '{"kind":"acme.analysis","schemaVersion":1,"title":"Research result","summary":"Key findings","content":{"findings":[]},"provenance":{"adapter":"manual"},"parentIds":[]}'
                        }
                      />
                      <p className="team-meta">
                        {publishMode === 'text'
                          ? 'Compression keeps the first 500 characters of each passage. Review what remains; the original is not saved.'
                          : 'Custom result kinds use your application’s namespace. The server validates the envelope and workspace access.'}
                      </p>
                      <Button
                        disabled={
                          busy ||
                          !text.trim() ||
                          (publishMode === 'text' && !title.trim())
                        }
                        onClick={() =>
                          void act(async () => {
                            const result: ArtifactInput =
                              publishMode === 'text'
                                ? await api.request(`${base}/preview`, {
                                    method: 'POST',
                                    body: JSON.stringify({ title, text }),
                                  })
                                : JSON.parse(text);
                            if (
                              !result ||
                              !result.kind ||
                              !result.content ||
                              !Array.isArray(result.parentIds)
                            )
                              throw new Error(
                                'Provide a full artifact JSON envelope.',
                              );
                            publishKey.current = crypto.randomUUID();
                            setPreview(result);
                          })
                        }
                      >
                        Review result
                      </Button>
                    </div>
                    {preview && (
                      <section className="team-preview">
                        <span className="team-section-label">
                          SHARED CONTENT PREVIEW
                        </span>
                        <h2>{preview.title}</h2>
                        <p>{preview.summary}</p>
                        {publishMode === 'text' ? (
                          <ArtifactContent artifact={preview} />
                        ) : (
                          <pre className="team-json">
                            {JSON.stringify(preview, null, 2)}
                          </pre>
                        )}
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(async () =>
                              published(
                                await api.publish(
                                  workspaceId,
                                  preview,
                                  publishKey.current,
                                ),
                              ),
                            )
                          }
                        >
                          Publish to {active.name}
                        </Button>
                      </section>
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="people">
                  <div className="team-panel">
                    <h2>Workspace members</h2>
                    {members.map((m) => (
                      <div className="team-list-row" key={m.userId}>
                        <div>
                          <strong>{m.displayName}</strong>
                          <small>Joined {date(m.joined)}</small>
                        </div>
                        {owner && m.role !== 'owner' ? (
                          <>
                            <NativeSelect
                              aria-label={`Role for ${m.displayName}`}
                              disabled={busy}
                              value={m.role}
                              onChange={(e) =>
                                void act(async () => {
                                  await api.request(
                                    `${base}/members/${encodeURIComponent(m.userId)}`,
                                    {
                                      method: 'PATCH',
                                      body: JSON.stringify({
                                        role: e.target.value,
                                      }),
                                    },
                                  );
                                  setMembers(
                                    (
                                      await api.request<{ items: Member[] }>(
                                        `${base}/members`,
                                      )
                                    ).items,
                                  );
                                })
                              }
                            >
                              <option value="viewer">Viewer</option>
                              <option value="editor">Editor</option>
                            </NativeSelect>
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  await api.request(
                                    `${base}/members/${encodeURIComponent(m.userId)}`,
                                    { method: 'DELETE' },
                                  );
                                  setMembers((previous) =>
                                    previous.filter(
                                      (p) => p.userId !== m.userId,
                                    ),
                                  );
                                })
                              }
                            >
                              Remove
                            </Button>
                          </>
                        ) : (
                          <span className="team-meta">{m.role}</span>
                        )}
                      </div>
                    ))}
                    {owner && (
                      <>
                        <h3>Group code</h3>
                        <p>
                          One code the whole group can type, so you do not need
                          an invitation each. Replace or turn it off at any
                          time. Everyone still needs access to this Site through
                          its sharing settings.
                        </p>
                        {joinCode ? (
                          <div className="team-secret">
                            <label htmlFor="group-code">
                              {joinCode.expires < clockNow
                                ? 'This code has expired. Replace it to let anyone else in.'
                                : `Share this code to join as ${joinCode.role}`}
                            </label>
                            <Input
                              id="group-code"
                              className="team-code"
                              readOnly
                              value={joinCode.code}
                            />
                            <Button
                              variant="outline"
                              onClick={() => void act(() => copy(joinCode.code))}
                            >
                              <Copy size={14} /> Copy code
                            </Button>
                            <p className="team-meta">
                              {joinCode.expires < clockNow
                                ? 'Expired'
                                : `Expires ${date(joinCode.expires)}`}
                              {' · '}
                              {joinCode.uses === 1
                                ? 'used once'
                                : `used ${joinCode.uses} times`}
                              {joinCode.maxUses === null
                                ? ''
                                : ` of ${joinCode.maxUses}`}
                            </p>
                            <div className="team-inline">
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void act(async () => {
                                    // Replacing is one call: the server revokes the old code
                                    // and issues the new one together.
                                    setJoinCode(
                                      await api.request<JoinCode>(
                                        `${base}/code`,
                                        {
                                          method: 'POST',
                                          body: JSON.stringify({
                                            role: joinCode.role,
                                          }),
                                        },
                                      ),
                                    );
                                    setNotice(
                                      'New code created. The old one no longer works.',
                                    );
                                  })
                                }
                              >
                                <RefreshCw size={14} /> Replace code
                              </Button>
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void act(async () => {
                                    await api.request(`${base}/code`, {
                                      method: 'DELETE',
                                    });
                                    setJoinCode(null);
                                    setNotice(
                                      'Code turned off. Nobody new can join with it.',
                                    );
                                  })
                                }
                              >
                                Turn off
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="team-inline">
                            <NativeSelect
                              aria-label="Group code role"
                              value={codeRole}
                              onChange={(e) => setCodeRole(e.target.value)}
                            >
                              <option value="editor">
                                Editor · read and publish
                              </option>
                              <option value="viewer">
                                Viewer · read results
                              </option>
                            </NativeSelect>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  setJoinCode(
                                    await api.request<JoinCode>(
                                      `${base}/code`,
                                      {
                                        method: 'POST',
                                        body: JSON.stringify({
                                          role: codeRole,
                                        }),
                                      },
                                    ),
                                  );
                                })
                              }
                            >
                              <KeyRound size={15} /> Create group code
                            </Button>
                          </div>
                        )}
                        <h3>Invite one person</h3>
                        <p>
                          Invitations can be used once and expire in seven days.
                          Your colleague also needs access to this Site through
                          its sharing settings.
                        </p>
                        <div className="team-inline">
                          <NativeSelect
                            aria-label="Invitation role"
                            value={inviteRole}
                            onChange={(e) => setInviteRole(e.target.value)}
                          >
                            <option value="viewer">
                              Viewer · read results
                            </option>
                            <option value="editor">
                              Editor · read and publish
                            </option>
                          </NativeSelect>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const i = await api.request<{ token: string }>(
                                  `${base}/invites`,
                                  {
                                    method: 'POST',
                                    body: JSON.stringify({ role: inviteRole }),
                                  },
                                );
                                setInviteLink(
                                  `${location.origin}/team#invite=${i.token}`,
                                );
                                setInvites(
                                  (
                                    await api.request<{ items: Invite[] }>(
                                      `${base}/invites`,
                                    )
                                  ).items,
                                );
                              })
                            }
                          >
                            Create invitation
                          </Button>
                        </div>
                        {inviteLink && (
                          <div className="team-secret">
                            <label htmlFor="invite-link">
                              Copy this invitation; it is shown only now.
                            </label>
                            <Input
                              id="invite-link"
                              readOnly
                              value={inviteLink}
                            />
                            <Button
                              variant="outline"
                              onClick={() => void act(() => copy(inviteLink))}
                            >
                              <Copy size={14} /> Copy invitation
                            </Button>
                          </div>
                        )}
                        {invites.map((i) => (
                          <div className="team-list-row" key={i.id}>
                            <span>
                              {i.role} invitation
                              <small>
                                {i.revoked
                                  ? 'Revoked'
                                  : i.usedBy
                                    ? 'Accepted'
                                    : i.expires < clockNow
                                      ? 'Expired'
                                      : `Expires ${date(i.expires)}`}
                              </small>
                            </span>
                            {!i.revoked && (
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void act(async () => {
                                    await api.request(
                                      `${base}/invites/${i.id}`,
                                      { method: 'DELETE' },
                                    );
                                    setInvites(
                                      (
                                        await api.request<{ items: Invite[] }>(
                                          `${base}/invites`,
                                        )
                                      ).items,
                                    );
                                    setInviteLink('');
                                  })
                                }
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </TabsContent>
                {owner && (
                  <TabsContent value="integrations">
                    <div className="team-panel">
                      <h2>
                        <KeyRound size={20} /> Connect another app or agent
                      </h2>
                      <p>
                        A key accesses only this workspace. Read keys retrieve
                        results; write keys can also publish and fold. Keys
                        expire after 30 days.
                      </p>
                      <div className="team-form">
                        <label htmlFor="integration-name">
                          Integration name
                        </label>
                        <Input
                          id="integration-name"
                          value={integrationName}
                          maxLength={80}
                          onChange={(e) => setIntegrationName(e.target.value)}
                          placeholder="e.g. Research agent"
                        />
                        <label htmlFor="integration-scope">Permission</label>
                        <NativeSelect
                          id="integration-scope"
                          value={scope}
                          onChange={(e) => setScope(e.target.value)}
                        >
                          <option value="read">Read results</option>
                          <option value="write">Read and publish</option>
                        </NativeSelect>
                        <Button
                          disabled={busy || !integrationName.trim()}
                          onClick={() =>
                            void act(async () => {
                              const t = await api.request<{ token: string }>(
                                `${base}/tokens`,
                                {
                                  method: 'POST',
                                  body: JSON.stringify({
                                    name: integrationName,
                                    scope,
                                  }),
                                },
                              );
                              setNewKey(t.token);
                              setIntegrationName('');
                              setIntegrations(
                                (
                                  await api.request<{ items: Integration[] }>(
                                    `${base}/tokens`,
                                  )
                                ).items,
                              );
                            })
                          }
                        >
                          Create integration key
                        </Button>
                      </div>
                      {newKey && (
                        <div className="team-secret">
                          <label htmlFor="new-key">
                            Save this key now. It cannot be shown again.
                          </label>
                          <Input id="new-key" readOnly value={newKey} />
                          <Button
                            variant="outline"
                            onClick={() => void act(() => copy(newKey))}
                          >
                            <Copy size={14} /> Copy key
                          </Button>
                          <Button variant="ghost" onClick={() => setNewKey('')}>
                            Hide key
                          </Button>
                        </div>
                      )}
                      {integrations.map((t) => (
                        <div className="team-list-row" key={t.id}>
                          <span>
                            <strong>{t.name}</strong>
                            <small>
                              {t.scope} ·{' '}
                              {t.revoked
                                ? 'Revoked'
                                : `Expires ${date(t.expires)}`}
                            </small>
                          </span>
                          {!t.revoked && (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  await api.request(`${base}/tokens/${t.id}`, {
                                    method: 'DELETE',
                                  });
                                  setIntegrations(
                                    (
                                      await api.request<{
                                        items: Integration[];
                                      }>(`${base}/tokens`)
                                    ).items,
                                  );
                                  setNewKey('');
                                })
                              }
                            >
                              Revoke
                            </Button>
                          )}
                        </div>
                      ))}
                      <h3>Workspace endpoint</h3>
                      <code className="team-endpoint">
                        /api/v1/workspaces/{workspaceId}/artifacts
                      </code>
                      <p className="team-meta">
                        Use the server-side TypeScript client and integration
                        guide included with the project. A private Site also
                        requires its platform access credential.
                      </p>
                    </div>
                  </TabsContent>
                )}
                <TabsContent value="activity">
                  <div className="team-panel">
                    <h2>Workspace activity</h2>
                    <p className="team-meta">
                      Latest 100 events, newest first. The integration feed
                      supports reading the full history by cursor.
                    </p>
                    {events.map((e) => (
                      <div className="team-list-row" key={e.sequence}>
                        <span>
                          {e.type.replaceAll('.', ' ').replaceAll('_', ' ')}
                          <small>{e.actorId}</small>
                        </span>
                        <span className="team-meta">{date(e.created)}</span>
                      </div>
                    ))}
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
        </section>
      </div>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="team-detail">
          <SheetHeader>
            <SheetTitle>{selected?.title}</SheetTitle>
            <SheetDescription>
              {selected
                ? `${kindName(selected.kind)} · ${selected.authorName}`
                : 'Shared result'}
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="team-detail-body">
              <p>{selected.summary}</p>
              <div className="team-inline">
                <Button
                  variant="outline"
                  onClick={() =>
                    void act(() =>
                      copy(
                        `${location.origin}/team?workspace=${workspaceId}&artifact=${selected.id}`,
                      ),
                    )
                  }
                >
                  <Copy size={14} /> Copy result link
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(selected, null, 2)], {
                      type: 'application/json',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${selected.id}.json`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  Export JSON
                </Button>
                {canWrite && selected.kind === CORPUS_KIND && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        published(
                          await api.fold(
                            workspaceId,
                            selected.id,
                            `source-fold-v1:${selected.id}`,
                          ),
                        ),
                      )
                    }
                  >
                    Create fold
                  </Button>
                )}
              </div>
              <ArtifactContent artifact={selected} />
              {selected.parentIds.length > 0 && (
                <section>
                  <h3>Source results</h3>
                  {selected.parentIds.map((id) => (
                    <Button
                      key={id}
                      variant="link"
                      onClick={() => void act(() => open(id))}
                    >
                      {id}
                    </Button>
                  ))}
                </section>
              )}
              <details>
                <summary>Provenance & integrity</summary>
                <pre className="team-json">
                  {JSON.stringify(
                    {
                      id: selected.id,
                      created: selected.created,
                      schemaVersion: selected.schemaVersion,
                      checksum: selected.checksum,
                      provenance: selected.provenance,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <DeepLink
        workspaceId={workspaceId}
        onResult={setSelected}
        onError={fail}
      />
    </main>
  );
}
function DeepLink({
  workspaceId,
  onResult,
  onError,
}: {
  workspaceId: string;
  onResult: (a: Artifact) => void;
  onError: (e: unknown) => void;
}) {
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('artifact');
    if (!workspaceId || !id || params.get('workspace') !== workspaceId) return;
    let cancelled = false;
    void api
      .get(workspaceId, id)
      .then((a) => {
        if (!cancelled) onResult(a);
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, onResult, onError]);
  return null;
}
