/**
 * The workspace conversation, as a reader sees it.
 *
 * Pure, and given `now` like the rest of the shared policy, so a test can fix the clock and
 * the server and browser cannot disagree about which day a message landed on.
 */

export type Message = {
  sequence: number;
  id: string;
  workspaceId: string;
  authorId: string;
  authorName: string;
  body: string;
  created: number;
  deleted: number | null;
};
/** A message is 4000 characters at most: a note to the team, not a document. */
export const MAX_MESSAGE_LENGTH = 4000;
/** Consecutive messages from one person inside this window read as one turn. */
const SAME_TURN = 5 * 60000;
const DAY = 86400000;

export type MessageTurn = {
  /** The first message's id, so React keys survive new arrivals. */
  key: string;
  authorId: string;
  authorName: string;
  created: number;
  messages: Message[];
};

/**
 * Merges each person's consecutive messages into one turn, the way a conversation reads,
 * and never merges across a day boundary so a date separator cannot land mid-turn.
 */
export function messageTurns(messages: Message[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  for (const message of [...messages].sort((a, b) => a.sequence - b.sequence)) {
    const open = turns.at(-1);
    if (
      open &&
      open.authorId === message.authorId &&
      message.created - (open.messages.at(-1)?.created ?? 0) < SAME_TURN &&
      sameDay(open.created, message.created)
    ) {
      open.messages.push(message);
      continue;
    }
    turns.push({
      key: message.id,
      authorId: message.authorId,
      authorName: message.authorName,
      created: message.created,
      messages: [message],
    });
  }
  return turns;
}

function sameDay(left: number, right: number) {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `Today`, `Yesterday`, or the date, in the reader's own timezone. */
export function dayLabel(at: number, now: number): string {
  if (sameDay(at, now)) return 'Today';
  if (sameDay(at, now - DAY)) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Whether this keypress sends. Enter sends and Shift+Enter writes a second line, which is
 * what a chat box does everywhere; it is named here so the rule can be stated once and
 * checked without a keyboard.
 */
export function sendsOnKey(key: string, shiftKey: boolean) {
  return key === 'Enter' && !shiftKey;
}

/** Whether a date separator belongs above this turn. */
export function startsNewDay(
  turns: MessageTurn[],
  index: number,
): boolean {
  const turn = turns[index];
  if (!turn) return false;
  const previous = turns[index - 1];
  return !previous || !sameDay(previous.created, turn.created);
}

/**
 * How many of these the reader has not seen, from the last sequence their browser
 * recorded. Their own messages never count as unread.
 */
export function unreadCount(
  messages: Message[],
  lastSeen: number,
  me: string | null,
): number {
  return messages.filter(
    (message) =>
      message.sequence > lastSeen &&
      message.deleted === null &&
      message.authorId !== me,
  ).length;
}
