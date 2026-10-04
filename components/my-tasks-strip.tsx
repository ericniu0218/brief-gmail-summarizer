'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { WorkspaceClient } from '@/lib/workspaces/client';
import { dueLabel, sortTasks, taskSummary, type Task } from '@/lib/tasks';
const api = new WorkspaceClient();

/**
 * What the team is waiting on you for, beside the morning's mail.
 *
 * The brief answers "what has arrived"; this answers "what did you already agree to".
 * It renders nothing at all when there is no team work outstanding, so a person who does
 * not use workspaces never sees it, and a quiet week shows nothing either.
 */
export function MyTasksStrip({ now }: { now: number | null }) {
  const [tasks, setTasks] = useState<(Task & { workspaceName: string })[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Signed out, or no workspaces, simply means nothing to show: this is a quiet extra on
    // the inbox and never reports its own failure there.
    const load = () =>
      api
        .request<{ items: (Task & { workspaceName: string })[] }>('tasks')
        .then((result) => {
          if (!cancelled) setTasks(result.items);
        })
        .catch(() => {});
    const timer = setTimeout(() => void load(), 0);
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, 300000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);
  // Until the browser's clock is known, nothing here can say what is late; see lib/importance.
  if (!tasks.length || now === null) return null;
  const summary = taskSummary(tasks, now);
  const soonest = sortTasks(tasks).slice(0, 3);
  return (
    <section className="team-strip">
      <h2>
        <ListChecks size={16} /> Your team tasks
        <span>
          {summary.overdue > 0 && `${summary.overdue} overdue · `}
          {summary.today > 0 && `${summary.today} due today · `}
          {summary.open} open
        </span>
      </h2>
      <ul>
        {soonest.map((task) => (
          <li key={task.id}>
            <strong>{task.title}</strong>
            <small>
              {task.workspaceName}
              {dueLabel(task, now) && ` · ${dueLabel(task, now)}`}
            </small>
          </li>
        ))}
      </ul>
      <Link href="/team">Open the workspace →</Link>
    </section>
  );
}
