import { normalizeEmailText } from './email-text';
import { htmlToText, splitQuoted, splitSignature } from './html-text';

/**
 * The reading view: a message's own text, laid out for reading.
 *
 * Built from the text the server already extracted (`Email.body`), never from the sender's
 * HTML, so nothing here can run, load or style itself. What it does is presentation only:
 * paragraphs, lists, headings and preformatted blocks are recognised, entities that leaked
 * through as literal text ("&nbsp;") are decoded, hard-wrapped lines are rejoined, link
 * targets become compact links, and a trailing mailing-list footer can be folded away.
 * The words themselves are never changed or dropped.
 */

export type ReadingPart = { kind: 'text'; value: string } | { kind: 'link'; href: string; label: string };
export type ReadingBlock =
  | { kind: 'paragraph'; lines: ReadingPart[][] }
  | { kind: 'heading'; parts: ReadingPart[] }
  | { kind: 'list'; ordered: boolean; items: ReadingPart[][] }
  | { kind: 'preformatted'; text: string }
  | { kind: 'table'; rows: ReadingPart[][][] };
export type ReadingDocument = { blocks: ReadingBlock[]; footer: ReadingBlock[] };

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: '', shy: '' };

/** Entities that reached the text as literal characters, such as "Thanks&nbsp;for". */
export function decodeLeftoverEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

/** A short, honest label for a link: its host and a hint of the path. */
function linkLabel(href: string) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname === '/' ? '' : url.pathname;
    return path.length > 24 || url.search || url.hash ? `${host}/…` : `${host}${path}`;
  } catch { return href.slice(0, 40); }
}

/** Only web links become links. Anything else stays as the text it was. */
function safeHref(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

/**
 * Text and links for one line. The server writes a link as "label (https://…)"; the label
 * is already in the text, so the bracketed address becomes a compact link beside it rather
 * than a wall of tracking parameters. A bare address becomes a link labelled by its host.
 */
export function readingParts(line: string): ReadingPart[] {
  const parts: ReadingPart[] = [];
  let cursor = 0;
  const push = (value: string) => { if (value) parts.push({ kind: 'text', value }); };
  for (const match of line.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const href = safeHref(match[0]);
    if (!href) continue;
    // "label (https://…)": drop the brackets around the address, keep the label text.
    const bracketed = line[start - 1] === '(' && line[start + match[0].length] === ')';
    push(line.slice(cursor, bracketed ? start - 1 : start).replace(/\s+$/, bracketed ? ' ' : ''));
    parts.push({ kind: 'link', href, label: linkLabel(href) });
    cursor = start + match[0].length + (bracketed ? 1 : 0);
  }
  push(line.slice(cursor));
  return parts.length ? parts : [{ kind: 'text', value: line }];
}

const LIST_ITEM = /^\s*(?:[-*•·◦▪]|\d{1,3}[.)])\s+/;
const ORDERED_ITEM = /^\s*\d{1,3}[.)]\s+/;
// Columns of text aligned with runs of spaces, a code-like line, or box drawing: layout the
// sender meant, which reflowing would destroy.
const ALIGNED = / {2,}\S+ {2,}\S/;
const CODE_LIKE = /^(?: {4}|\t)|[{};]\s*$|^\s*(?:\$|>|#!|curl |git |npm |SELECT |import |def |function )|[─│┌┐└┘├┤]/;
const SENTENCE_END = /[.!?:;,)"”’]$/;

function isPreformatted(lines: string[]) {
  const shaped = lines.filter(line => ALIGNED.test(line) || CODE_LIKE.test(line)).length;
  return shaped >= Math.max(1, Math.ceil(lines.length / 2)) && lines.some(line => /\S/.test(line));
}

function isHeading(lines: string[], next: string | undefined) {
  if (lines.length !== 1 || !next) return false;
  const line = lines[0].trim();
  if (line.length < 3 || line.length > 70 || SENTENCE_END.test(line) && !line.endsWith(':')) return false;
  if (/^(?:hi|hello|hey|dear|thanks|thank you|best|regards|cheers)\b/i.test(line)) return false;
  const letters = line.replace(/[^a-z]/gi, '');
  return line.endsWith(':') || (letters.length >= 4 && letters === letters.toUpperCase());
}

/** Rejoin lines that were hard-wrapped by the sender's mail program; keep deliberate breaks. */
function reflow(lines: string[]) {
  const long = lines.filter(line => line.length >= 60).length;
  if (lines.length < 3 || long < lines.length - 1) return lines.map(line => line.replace(/[ \t ]{2,}/g, ' ').trim());
  return [lines.map(line => line.trim()).join(' ').replace(/[ \t ]{2,}/g, ' ')];
}

// Wording that marks mailing-list boilerplate. A footer is folded only when it is the last
// thing in the message, made of these paragraphs (and the address lines beside them).
const FOOTER_CUE = /\b(?:unsubscribe|manage (?:your )?(?:email )?preferences|update (?:your )?(?:email )?preferences|email preferences|view (?:this email |it )?(?:in|on) (?:your |a |the )?(?:browser|web)|you(?:'re| are) receiving this|you received this|this email was sent to|sent to you because|no longer wish to receive|opt[- ]out|privacy policy|terms of (?:service|use)|all rights reserved|add [^ ]+@[^ ]+ to your address book)\b|©|\(c\) \d{4}/i;
const ADDRESS_LIKE = /^(?=.{1,160}$)[^.!?\n]{0,40}\b\d{1,6}\s+[^.!?\n]+\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?)\b/i;

function splitFooter(paragraphs: string[][]) {
  let start = paragraphs.length;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const text = paragraphs[i].join(' ');
    const cue = FOOTER_CUE.test(text);
    // A postal address usually sits just above or below the unsubscribe line. It joins the
    // footer only as part of a run that contains a real footer cue (checked below).
    const nearCue = ADDRESS_LIKE.test(text) && text.length <= 200;
    if ((cue && text.length <= 600) || nearCue) start = i;
    else break;
  }
  if (start === paragraphs.length || !paragraphs.slice(start).some(p => FOOTER_CUE.test(p.join(' ')))) return { body: paragraphs, footer: [] };
  // Never fold away most of the message: a short email that is mostly legal text stays whole.
  const size = (list: string[][]) => list.reduce((sum, p) => sum + p.join(' ').length, 0);
  if (start === 0 || size(paragraphs.slice(start)) > size(paragraphs.slice(0, start)) * 2) return { body: paragraphs, footer: [] };
  return { body: paragraphs.slice(0, start), footer: paragraphs.slice(start) };
}

/** Most columns and rows a reading-view table shows; anything larger stays as text. */
const MAX_COLUMNS = 8;
const MAX_ROWS = 200;

/**
 * A paragraph split into runs of table rows (two or more tab-separated cells, from a table
 * in the sender's HTML) and runs of ordinary lines, so a single-cell intro above a
 * two-column section stays a paragraph instead of being squeezed into one column.
 */
function runs(lines: string[]) {
  const out: { table: boolean; lines: string[] }[] = [];
  for (const line of lines) {
    const table = line.includes('\t') && line.split('\t').filter(cell => cell.trim()).length > 1;
    const last = out[out.length - 1];
    if (last && last.table === table) last.lines.push(line);
    else out.push({ table, lines: [line] });
  }
  return out;
}

function lineBlock(lines: string[], next: string | undefined): ReadingBlock {
  if (isPreformatted(lines)) return { kind: 'preformatted', text: lines.join('\n') };
  if (lines.length >= 2 && lines.every(line => LIST_ITEM.test(line)))
    return { kind: 'list', ordered: lines.every(line => ORDERED_ITEM.test(line)), items: lines.map(line => readingParts(line.replace(LIST_ITEM, '').trim())) };
  if (isHeading(lines, next)) return { kind: 'heading', parts: readingParts(lines[0].trim().replace(/:$/, '')) };
  return { kind: 'paragraph', lines: reflow(lines).map(readingParts) };
}

function toBlocks(paragraphs: string[][]): ReadingBlock[] {
  return paragraphs.flatMap((lines, index): ReadingBlock[] => runs(lines).map(run => {
    const rows = run.lines.map(line => line.split('\t'));
    if (run.table && rows.every(row => row.length <= MAX_COLUMNS) && rows.length <= MAX_ROWS)
      return { kind: 'table', rows: rows.map(row => row.map(cell => readingParts(cell.trim()))) };
    return lineBlock(run.lines.map(line => line.replace(/\t+/g, ' ')), paragraphs[index + 1]?.[0]);
  }));
}

/**
 * The text a reading view shows. From the HTML when there is some — keeping table cells
 * apart, which the stored text does not — with quoted history and the signature split off
 * exactly as the server does; otherwise the stored text.
 */
export function readingSource(email: { html?: string; body: string }) {
  if (!email.html) return email.body;
  const { current } = splitQuoted(htmlToText(email.html, { cells: true }));
  return splitSignature(current).body || email.body;
}

export function readingDocument(body: string): ReadingDocument {
  const text = normalizeEmailText(decodeLeftoverEntities(body || ''));
  const paragraphs = text.split(/\n{2,}/).map(paragraph => paragraph.split('\n')).filter(lines => lines.some(line => line.trim()));
  const { body: main, footer } = splitFooter(paragraphs);
  return { blocks: toBlocks(main), footer: toBlocks(footer) };
}
