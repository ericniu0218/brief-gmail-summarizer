'use client';
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, Trash2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { WorkspaceClient } from '@/lib/workspaces/client';
import type { Member } from '@/lib/workspaces/contracts';
import {
  byDeadline,
  byPerson,
  byStatus,
  dueLabel,
  isClosed,
  STATUS_LABEL,
  TASK_STATUSES,
  taskSummary,
  type Task,
  type TaskGroup,
} from '@/lib/tasks';

/**
 * The team's work: who is on what, and by when.
 *
 * Grouping and ordering are decided by `lib/tasks` from a clock read here, so the view
 * re-ranks as the day passes without the server rewriting anything. Every change names the
 * version it edits; when somebody else got there first the server refuses the save and this
 * reloads rather than quietly winning.
 */

const api = new WorkspaceClient();
type View = 'person' | 'deadline' | 'status';
const VIEWS: { id: View; label: string }[] = [
  { id: 'person', label: 'By person' },
  { id: 'deadline', label: 'By deadline' },
  { id: 'status', label: 'By status' },
];
/** `YYYY-MM-DD` for a date input, which is also how a day deadline is sent. */
const dateValue = (task: Task) =>
  task.dueAt === null || task.dueKind !== 'day'
    ? ''
    : new Date(task.dueAt).toISOString().slice(0, 10);

export function TeamTasks({
  workspaceId,
  members,
  canWrite,
  busy,
  act,
  notify,
}: {
  workspaceId: string;
  members: Member[];
  canWrite: boolean;
  busy: boolean;
  act: (fn: () => Promise<void>) => void;
  notify: (message: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [view, setView] = useState<View>('person');
  const [mineOnly, setMineOnly] = useState(false);
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [due, setDue] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const base = `workspaces/${encodeURIComponent(workspaceId)}/tasks`;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api.request<{
        items: Task[];
        me: { userId: string | null };
      }>(base, signal ? { signal } : {});
      if (signal?.aborted) return;
      setTasks(result.items);
      setMe(result.me.userId);
      setNow(Date.now());
    },
    [base],
  );
  useEffect(() => {
    // Tasks refresh on the same rhythm as the rest of the workspace, and the clock ticks on
    // its own so "Due today" becomes "Overdue" without anybody reloading. The first load is
    // scheduled rather than run in the effect body, which would re-render during render.
    const controller = new AbortController();
    const first = setTimeout(
      () =>
        void load(controller.signal).catch((error) => {
          if (!controller.signal.aborted) notify((error as Error).message);
        }),
      0,
    );
    const refresh = setInterval(() => {
      if (!document.hidden) void load(controller.signal).catch(() => {});
    }, 15000);
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      controller.abort();
      clearTimeout(first);
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, [load, notify]);

  /** Applies one change, then reloads so a refused save shows the current task. */
  const change = (task: Task, patch: Record<string, unknown>) =>
    act(async () => {
      try {
        await api.request(`${base}/${encodeURIComponent(task.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ version: task.version, ...patch }),
        });
      } finally {
        await load();
      }
    });

  const visible = mineOnly
    ? tasks.filter((task) => task.assigneeId !== null && task.assigneeId === me)
    : tasks;
  const groups: TaskGroup[] =
    view === 'person'
      ? byPerson(visible, members)
      : view === 'deadline'
        ? byDeadline(visible, now)
        : byStatus(visible);
  const summary = taskSummary(visible, now);

  return (
    <div className="team-panel">
      <h2>Who is working on what</h2>
      <p className="team-meta">
        {summary.open === 0
          ? 'Nothing is open. Add the first task below.'
          : `${summary.open} open · ${summary.overdue} overdue · ${summary.today} due today · ${summary.unassigned} unassigned`}
      </p>
      <div className="team-inline">
        {VIEWS.map((option) => (
          <Button
            key={option.id}
            variant={view === option.id ? 'default' : 'outline'}
            onClick={() => setView(option.id)}
          >
            {option.label}
          </Button>
        ))}
        {me && (
          <label className="team-check">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            Only mine
          </label>
        )}
      </div>

      {canWrite && (
        <form
          className="team-task-add"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await api.request(base, {
                method: 'POST',
                // A key per submission, so a retry on a flaky connection cannot add the
                // same task twice.
                headers: { 'Idempotency-Key': crypto.randomUUID() },
                body: JSON.stringify({
                  title,
                  assigneeId: assigneeId || null,
                  due: due || null,
                }),
              });
              setTitle('');
              setDue('');
              await load();
            });
          }}
        >
          <Input
            aria-label="Task"
            value={title}
            required
            maxLength={200}
            placeholder="What needs doing?"
            onChange={(e) => setTitle(e.target.value)}
          />
          <NativeSelect
            aria-label="Assign to"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
                {member.userId === me ? ' (me)' : ''}
              </option>
            ))}
          </NativeSelect>
          <Input
            aria-label="Due date"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            <Plus size={15} /> Add task
          </Button>
        </form>
      )}

      {groups.length === 0 && (
        <p className="team-meta">
          {mineOnly ? 'Nothing is assigned to you.' : 'No tasks yet.'}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className="team-task-group">
          <h3>
            {view === 'person' && <UserRound size={15} />}
            {view === 'deadline' && <CalendarClock size={15} />}
            {group.label}
            <small>{group.tasks.length}</small>
          </h3>
          {group.tasks.length === 0 ? (
            <p className="team-meta">Nothing assigned.</p>
          ) : (
            group.tasks.map((task) => (
              <div
                className={`team-task ${isClosed(task.status) ? 'closed' : ''}`}
                key={task.id}
              >
                <div className="team-task-title">
                  <strong>{task.title}</strong>
                  <small>
                    {view === 'person'
                      ? STATUS_LABEL[task.status]
                      : (task.assigneeName ?? 'Unassigned')}
                    {dueLabel(task, now) && (
                      <span
                        className={
                          dueLabel(task, now)?.startsWith('Overdue')
                            ? 'team-task-late'
                            : undefined
                        }
                      >
                        {' · '}
                        {dueLabel(task, now)}
                      </span>
                    )}
                  </small>
                </div>
                {canWrite && (
                  <>
                    <NativeSelect
                      aria-label={`Status of ${task.title}`}
                      disabled={busy}
                      value={task.status}
                      onChange={(e) => change(task, { status: e.target.value })}
                    >
                      {TASK_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {STATUS_LABEL[status]}
                        </option>
                      ))}
                    </NativeSelect>
                    <NativeSelect
                      aria-label={`Who is doing ${task.title}`}
                      disabled={busy}
                      value={task.assigneeId ?? ''}
                      onChange={(e) =>
                        change(task, { assigneeId: e.target.value || null })
                      }
                    >
                      <option value="">Unassigned</option>
                      {members.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                      {task.assigneeId &&
                        !members.some((m) => m.userId === task.assigneeId) && (
                          <option value={task.assigneeId}>
                            {task.assigneeName} (left)
                          </option>
                        )}
                    </NativeSelect>
                    <Input
                      aria-label={`Deadline for ${task.title}`}
                      type="date"
                      disabled={busy}
                      value={dateValue(task)}
                      onChange={(e) =>
                        change(task, { due: e.target.value || null })
                      }
                    />
                    <Button
                      variant="ghost"
                      aria-label={`Delete ${task.title}`}
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await api.request(
                            `${base}/${encodeURIComponent(task.id)}`,
                            { method: 'DELETE' },
                          );
                          await load();
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  </>
                )}
              </div>
            ))
          )}
        </section>
      ))}
    </div>
  );
}
