import { endOfUtcDay } from './classification';

/**
 * Team tasks: who is doing what, by when.
 *
 * Everything here is pure and takes `now` as an argument, exactly like the importance
 * policy, so the server and the browser cannot disagree about what is overdue and a test
 * can fix the clock. A deadline is stored as an instant plus the precision it was given in:
 * a task due on a day ends when that day ends (`endOfUtcDay`, the rule mail deadlines
 * already use), while a task due at a time is that instant.
 */

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled';
export const TASK_STATUSES: TaskStatus[] = [
  'todo',
  'doing',
  'blocked',
  'done',
  'cancelled',
];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  doing: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};
/** Work nobody is expected to pick up again. */
export const CLOSED_STATUSES: TaskStatus[] = ['done', 'cancelled'];
export const isClosed = (status: TaskStatus) => CLOSED_STATUSES.includes(status);

export type Task = {
  id: string;
  workspaceId: string;
  title: string;
  detail: string;
  status: TaskStatus;
  /** A member's user id, or null when the work is not claimed yet. */
  assigneeId: string | null;
  assigneeName: string | null;
  dueAt: number | null;
  /** `day` means the date was given without a time; see `taskDueAt`. */
  dueKind: 'day' | 'time' | null;
  createdBy: string;
  creatorName: string;
  created: number;
  updated: number;
  /** Incremented on every change; an update must name the version it is editing. */
  version: number;
  completed: number | null;
};

/**
 * Resolves a deadline as given. `date` is a `YYYY-MM-DD` day; `time` is an exact instant.
 * `null` clears a deadline, and anything unparseable is refused rather than guessed at,
 * because a task that quietly lands on the wrong day is worse than one with no date.
 */
export function taskDueAt(
  value: unknown,
): { dueAt: number; dueKind: 'day' | 'time' } | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const day = endOfUtcDay(value);
  if (day !== undefined) return { dueAt: day, dueKind: 'day' };
  const instant = Date.parse(value);
  // A bare date is handled above, so anything reaching here must carry a time.
  return Number.isFinite(instant) && /\d:\d/.test(value)
    ? { dueAt: instant, dueKind: 'time' }
    : undefined;
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due this week',
  later: 'Later',
  none: 'No deadline',
};
export const DUE_BUCKETS: DueBucket[] = [
  'overdue',
  'today',
  'week',
  'later',
  'none',
];

/** The end of the viewer's own day, which is what a person means by "today". */
function endOfLocalDay(now: number) {
  const date = new Date(now);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function dueBucket(
  task: Pick<Task, 'dueAt' | 'status'>,
  now: number,
): DueBucket {
  if (task.dueAt === null) return 'none';
  // Closed work is never chased: a finished task that was late is history, not a warning.
  if (task.dueAt < now) return isClosed(task.status) ? 'later' : 'overdue';
  if (task.dueAt <= endOfLocalDay(now)) return 'today';
  return task.dueAt <= endOfLocalDay(now) + 6 * 86400000 ? 'week' : 'later';
}

/** A short deadline for a person to read, in their own timezone. */
export function dueLabel(
  task: Pick<Task, 'dueAt' | 'dueKind' | 'status'>,
  now: number,
): string | undefined {
  if (task.dueAt === null) return undefined;
  const date = new Date(task.dueAt);
  // A day-level deadline shows as a date. Printing its 23:59 instant would invent a
  // precision the task was never given.
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const stamp =
    task.dueKind === 'time'
      ? `${day}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : day;
  const bucket = dueBucket(task, now);
  if (bucket === 'overdue') return `Overdue · ${stamp}`;
  return bucket === 'today' ? `Today · ${stamp}` : stamp;
}

/**
 * Deterministic order: live work first, then the soonest deadline, then undated work, and
 * finally the id, so two tasks created in the same millisecond never swap places between
 * renders.
 */
export function sortTasks<T extends Task>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (isClosed(a.status) !== isClosed(b.status)) return isClosed(a.status) ? 1 : -1;
    const left = a.dueAt ?? Infinity;
    const right = b.dueAt ?? Infinity;
    if (left !== right) return left - right;
    if (a.created !== b.created) return a.created - b.created;
    return a.id.localeCompare(b.id);
  });
}

export type TaskGroup = { key: string; label: string; tasks: Task[] };

/** One group per person, plus unclaimed work. Members with nothing open are kept, because
 * "nobody is on this" and "this person has nothing" are both answers worth seeing. */
export function byPerson(
  tasks: Task[],
  members: { userId: string; displayName: string }[],
): TaskGroup[] {
  const sorted = sortTasks(tasks);
  const groups = new Map<string, TaskGroup>();
  for (const member of members)
    groups.set(member.userId, {
      key: member.userId,
      label: member.displayName,
      tasks: [],
    });
  const unassigned: TaskGroup = {
    key: '',
    label: 'Unassigned',
    tasks: [],
  };
  for (const task of sorted) {
    if (task.assigneeId === null) {
      unassigned.tasks.push(task);
      continue;
    }
    // Someone who has left the workspace keeps their work visible under their name rather
    // than having it silently vanish from every view.
    const group = groups.get(task.assigneeId);
    if (group) group.tasks.push(task);
    else
      groups.set(task.assigneeId, {
        key: task.assigneeId,
        label: `${task.assigneeName ?? 'Former member'} (left)`,
        tasks: [task],
      });
  }
  return [unassigned, ...groups.values()].filter(
    (group) => group.key === '' ? group.tasks.length > 0 : true,
  );
}

export function byDeadline(tasks: Task[], now: number): TaskGroup[] {
  const sorted = sortTasks(tasks.filter((task) => !isClosed(task.status)));
  return DUE_BUCKETS.map((bucket) => ({
    key: bucket,
    label: BUCKET_LABEL[bucket],
    tasks: sorted.filter((task) => dueBucket(task, now) === bucket),
  })).filter((group) => group.tasks.length > 0);
}

export function byStatus(tasks: Task[]): TaskGroup[] {
  const sorted = sortTasks(tasks);
  return TASK_STATUSES.map((status) => ({
    key: status,
    label: STATUS_LABEL[status],
    tasks: sorted.filter((task) => task.status === status),
  })).filter((group) => group.tasks.length > 0);
}

/** Counts for a one-line summary: what is late, what is due today, what is still open. */
export function taskSummary(tasks: Task[], now: number) {
  const open = tasks.filter((task) => !isClosed(task.status));
  const count = (bucket: DueBucket) =>
    open.filter((task) => dueBucket(task, now) === bucket).length;
  return {
    open: open.length,
    overdue: count('overdue'),
    today: count('today'),
    unassigned: open.filter((task) => task.assigneeId === null).length,
  };
}
