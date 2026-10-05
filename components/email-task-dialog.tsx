'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { WorkspaceClient } from '@/lib/workspaces/client';
import type { Member, Workspace } from '@/lib/workspaces/contracts';
import type { Email } from '@/lib/mail';
const api = new WorkspaceClient();

/**
 * Turns the message on screen into a team task.
 *
 * The deadline is not typed in again: Brief already worked out what this message asks for
 * and by when, so the draft arrives with that date filled in. The text describing the
 * message is written by the server from its own copy of the mailbox, and this sends back
 * the hash of the draft that was shown, so a task is never added from wording nobody read.
 */
export function AddToTeamTask({ email }: { email: Email }) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [loaded, setLoaded] = useState<{
    workspaceId: string;
    draft: { title: string; detail: string; due: string | null };
    draftHash: string;
  } | null>(null);
  // A draft belongs to the workspace it was built for. Keeping that on the record, rather
  // than clearing it when the workspace changes, means nothing stale can be submitted and
  // the switch costs no extra render.
  const draft = loaded?.workspaceId === workspaceId ? loaded : null;
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [notice, setNotice] = useState('');
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef('');
  const accountId = email.accountId ?? '';

  useEffect(() => {
    // Only workspaces this person can write to can receive a task.
    if (!open) return;
    let cancelled = false;
    void api
      .request<{ items: Workspace[] }>('workspaces')
      .then((result) => {
        if (cancelled) return;
        const writable = result.items.filter((w) => w.role !== 'viewer');
        setWorkspaces(writable);
        setWorkspaceId((previous) =>
          writable.some((w) => w.id === previous)
            ? previous
            : (writable[0]?.id ?? ''),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    // The draft is rebuilt per workspace and message: its hash is what the create call is
    // checked against, and the member list belongs to the chosen workspace.
    if (!open || !workspaceId) return;
    let cancelled = false;
    key.current = crypto.randomUUID();
    void Promise.all([
      api.request<{
        draft: { title: string; detail: string; due: string | null };
        draftHash: string;
      }>(`workspaces/${encodeURIComponent(workspaceId)}/task-from-email`, {
        method: 'POST',
        body: JSON.stringify({ accountId, messageId: email.id }),
      }),
      api.request<{ items: Member[] }>(
        `workspaces/${encodeURIComponent(workspaceId)}/members`,
      ),
    ])
      .then(([result, people]) => {
        if (cancelled) return;
        setLoaded({ workspaceId, ...result });
        setTitle(result.draft.title);
        setDue(result.draft.due?.slice(0, 10) ?? '');
        setMembers(people.items);
        setNotice('');
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, accountId, email.id]);

  async function create() {
    setBusy(true);
    setNotice('');
    try {
      await api.request(
        `workspaces/${encodeURIComponent(workspaceId)}/task-from-email`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key.current },
          body: JSON.stringify({
            accountId,
            messageId: email.id,
            create: true,
            draftHash: draft?.draftHash,
            title,
            assigneeId: assigneeId || null,
            due: due || null,
          }),
        },
      );
      setAdded(true);
      setNotice('Added to the workspace.');
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="button white"
        disabled={!accountId || accountId === 'all'}
        onClick={() => {
          setOpen(true);
          setAdded(false);
          setNotice('');
        }}
      >
        <ListChecks size={14} /> Add to team task
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="team-share-dialog">
          <DialogHeader>
            <DialogTitle>Add this message as a team task</DialogTitle>
            <DialogDescription>
              Your teammates see the task, the sender&rsquo;s name and the
              summary — not the message itself.
            </DialogDescription>
          </DialogHeader>
          <div className="team-form">
            <label htmlFor="task-workspace">Workspace</label>
            <NativeSelect
              id="task-workspace"
              disabled={busy}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </NativeSelect>
            {!workspaces.length && (
              <Link href="/team">Create or join a workspace first →</Link>
            )}
            <label htmlFor="task-title">Task</label>
            <Input
              id="task-title"
              value={title}
              disabled={busy || !draft}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label htmlFor="task-assignee">Who is doing it</label>
            <NativeSelect
              id="task-assignee"
              disabled={busy || !draft}
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </NativeSelect>
            <label htmlFor="task-due">Deadline</label>
            <Input
              id="task-due"
              type="date"
              value={due}
              disabled={busy || !draft}
              onChange={(e) => setDue(e.target.value)}
            />
            {draft?.draft.due && (
              <p className="team-meta">
                Taken from the deadline Brief found in this message.
              </p>
            )}
            {draft && (
              <p className="team-meta">
                Your teammates will see: {draft.draft.detail}
              </p>
            )}
            {notice && <output>{notice}</output>}
            {added ? (
              <Link href={`/team?workspace=${workspaceId}`}>
                Open team workspace →
              </Link>
            ) : (
              <Button
                disabled={busy || !draft || !workspaceId || !title.trim()}
                onClick={() => void create()}
              >
                Add task
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
