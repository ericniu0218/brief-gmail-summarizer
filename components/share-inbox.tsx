'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ArtifactContent } from './artifact-content';
import { WorkspaceClient } from '@/lib/workspaces/client';
import type { ArtifactInput, Workspace } from '@/lib/workspaces/contracts';
import type { Email } from '@/lib/mail';
const api = new WorkspaceClient();

/**
 * Preview-before-publish flow for sharing selected summaries with a team. The server
 * rebuilds the preview from the private snapshot; the browser never submits email bodies.
 */
export function ShareInbox({
  emails,
  accountId,
}: {
  emails: Email[];
  accountId: string;
}) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [title, setTitle] = useState('Inbox briefing');
  const [preview, setPreview] = useState<{
    preview: ArtifactInput;
    previewHash: string;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef('');
  useEffect(() => {
    // Only editor and owner workspaces can receive a new shared artifact.
    if (!open) return;
    let cancelled = false;
    void api
      .request<{ items: Workspace[] }>('workspaces')
      .then((result) => {
        if (cancelled) return;
        const writable = result.items.filter((w) => w.role !== 'viewer');
        setWorkspaces(writable);
        setWorkspaceId(writable[0]?.id ?? '');
      })
      .catch((error) => {
        if (!cancelled) setNotice(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accountId]);
  // Changing the sharing mailbox invalidates any reviewed preview and selection: the
  // messages belonged to the previous account, so publishing them here would share
  // something the user never reviewed for this workspace. This adjusts state during
  // render rather than in an effect, so the reset lands in the same render as the new
  // account instead of causing a second pass with stale data briefly visible.
  const [previewAccount, setPreviewAccount] = useState(accountId);
  if (previewAccount !== accountId) {
    setPreviewAccount(accountId);
    setPreview(null);
    setIds([]);
    setNotice('');
  }
  function changeOpen(value: boolean) {
    setOpen(value);
    if (value) {
      setPreview(null);
      setIds([]);
      setNotice('');
    }
  }
  async function submit(publish: boolean) {
    setBusy(true);
    setNotice('');
    try {
      // Preview and publish share one idempotency key. The server also requires the preview
      // hash, so a changed mailbox cannot be published without another review.
      if (!publish) key.current = crypto.randomUUID();
      const result = await api.request<{
        preview: ArtifactInput;
        previewHash: string;
      }>(`workspaces/${workspaceId}/capture`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({
          accountId,
          messageIds: ids,
          title,
          publish,
          previewHash: preview?.previewHash,
        }),
      });
      if (publish) {
        setPreview(null);
        setIds([]);
        setNotice(
          'Published. Your teammates can read this corpus in the workspace.',
        );
      } else setPreview(result);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Sharing failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="button white"
        disabled={!accountId || accountId === 'all'}
        onClick={() => changeOpen(true)}
      >
        <Users size={15} /> Share to team
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="team-share-dialog">
          <DialogHeader>
            <DialogTitle>Share selected inbox summaries</DialogTitle>
            <DialogDescription>
              Choose the messages and review the exact text your workspace will
              receive.
            </DialogDescription>
          </DialogHeader>
          <div className="team-form">
            <label htmlFor="share-workspace">Workspace</label>
            <NativeSelect
              id="share-workspace"
              disabled={busy}
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setPreview(null);
              }}
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
            <label htmlFor="share-title">Corpus title</label>
            <Input
              id="share-title"
              value={title}
              disabled={busy}
              maxLength={160}
              onChange={(e) => {
                setTitle(e.target.value);
                setPreview(null);
              }}
            />
            <div className="team-message-pick">
              {emails.slice(0, 60).map((email) => (
                <label key={email.id} htmlFor={`share-message-${email.id}`}>
                  <Checkbox
                    id={`share-message-${email.id}`}
                    checked={ids.includes(email.id)}
                    disabled={busy}
                    onCheckedChange={(checked) => {
                      setIds((previous) =>
                        checked
                          ? [...previous, email.id]
                          : previous.filter((id) => id !== email.id),
                      );
                      setPreview(null);
                    }}
                  />
                  <span>
                    <strong>{email.subject}</strong>
                    <small>{email.sender}</small>
                  </span>
                </label>
              ))}
            </div>
            <p className="team-meta">
              Shared fields: subject, sender name, message ID, and summary.
              Check summaries for sensitive content before publishing.
            </p>
            {notice && <output>{notice}</output>}
            {preview ? (
              <>
                <ArtifactContent artifact={preview.preview} />
                <Button disabled={busy} onClick={() => void submit(true)}>
                  Publish {ids.length} summaries to workspace
                </Button>
              </>
            ) : (
              <Button
                disabled={busy || !workspaceId || !ids.length || !title.trim()}
                onClick={() => void submit(false)}
              >
                Preview {ids.length} selected summaries
              </Button>
            )}
            <Link href={`/team?workspace=${workspaceId}`}>
              Open team workspace →
            </Link>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
