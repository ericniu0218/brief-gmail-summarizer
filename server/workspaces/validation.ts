import { HttpError } from '../runtime';
import {
  CORPUS_KIND,
  FOLD_KIND,
  MAX_REQUEST_BYTES,
  type ArtifactInput,
  type CorpusDocument,
  type Json,
} from '@/lib/workspaces/contracts';

/**
 * Validation boundary for workspace APIs. Requests are kept within size and nesting
 * limits, built-in artifact shapes are checked explicitly, and canonical JSON provides
 * stable input for hashes and identifiers.
 */

// Primitive validators shared by every workspace artifact contract.
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function string(
  value: unknown,
  label: string,
  max = 160,
  empty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    throw new HttpError(
      400,
      `${label} must be ${empty ? '0' : '1'}–${max} characters.`,
    );
  return value.trim();
}
export function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new HttpError(400, `Invalid ${label}.`);
  return Number(value);
}

// Deterministic serialization and cryptographic helpers used for content identity and
// opaque credentials. Sorting object keys makes equivalent JSON hash the same way.
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const data = object(value);
  return `{${Object.keys(data)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(data[key])}`)
    .join(',')}}`;
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
export function secret(prefix: string) {
  return (
    prefix +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('')
  );
}
function jsonDepth(value: unknown, depth = 0): void {
  if (depth > 20) throw new HttpError(400, 'JSON nesting exceeds 20 levels.');
  if (value && typeof value === 'object')
    for (const entry of Object.values(value)) jsonDepth(entry, depth + 1);
}

// Built-in artifact contracts receive deeper validation than third-party namespaced
// kinds, whose application-specific content remains opaque JSON.
export function corpusDocuments(value: unknown): CorpusDocument[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200)
    throw new HttpError(400, 'A corpus needs 1–200 documents.');
  const ids = new Set<string>();
  return value.map((item) => {
    const d = object(item);
    const id = string(d.id, 'Document ID');
    if (ids.has(id)) throw new HttpError(400, 'Document IDs must be unique.');
    ids.add(id);
    return {
      id,
      title: string(d.title, 'Document title', 240),
      text: string(d.text, 'Document text', 16000),
      source: string(d.source, 'Source', 240),
    };
  });
}
export function artifactInput(value: unknown): ArtifactInput {
  jsonDepth(value);
  const d = object(value);
  const kind = string(d.kind, 'Kind', 100);
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(kind))
    throw new HttpError(400, 'Use a namespaced kind, such as acme.analysis.');
  if (!Array.isArray(d.parentIds) || d.parentIds.length > 20)
    throw new HttpError(400, 'Provide up to 20 parent IDs.');
  const parentIds = [
    ...new Set(d.parentIds.map((id) => string(id, 'Parent ID'))),
  ];
  const result: ArtifactInput = {
    kind,
    schemaVersion: integer(d.schemaVersion, 'schemaVersion', 1, 10000),
    title: string(d.title, 'Title'),
    summary: string(d.summary, 'Summary', 2000, true),
    content: object(d.content) as Record<string, Json>,
    provenance: object(d.provenance) as Record<string, Json>,
    parentIds,
  };
  if (kind.startsWith('brief.') && ![CORPUS_KIND, FOLD_KIND].includes(kind))
    throw new HttpError(
      400,
      'The brief namespace is reserved. Use your application namespace.',
    );
  if ([CORPUS_KIND, FOLD_KIND].includes(kind) && result.schemaVersion !== 1)
    throw new HttpError(400, 'Unsupported built-in schema version.');
  if (kind === CORPUS_KIND) {
    corpusDocuments(result.content.documents);
    string(result.content.method, 'Compression method');
    integer(result.content.originalBytes, 'originalBytes', 0, 1000000000);
    integer(result.content.storedTextBytes, 'storedTextBytes', 0, 1000000000);
  }
  if (kind === FOLD_KIND) {
    string(result.content.method, 'Fold method');
    if (
      parentIds.length !== 1 ||
      !Array.isArray(result.content.groups) ||
      result.content.groups.length > 200
    )
      throw new HttpError(
        400,
        'A fold needs one corpus parent and up to 200 groups.',
      );
    for (const value of result.content.groups) {
      const group = object(value);
      string(group.source, 'Group source', 240);
      string(group.text, 'Group text', 16000);
      if (
        !Array.isArray(group.documentIds) ||
        !group.documentIds.length ||
        group.documentIds.length > 200
      )
        throw new HttpError(400, 'A group needs document citations.');
      group.documentIds.forEach((id) => string(id, 'Citation ID'));
    }
  }
  if (
    new TextEncoder().encode(canonical(result)).byteLength > MAX_REQUEST_BYTES
  )
    throw new HttpError(413, 'Result exceeds the 256 KiB MVP limit.');
  return result;
}

// Enforce the byte limit while streaming so an oversized body is rejected before the
// server allocates and parses the complete request.
export async function readBody(request: Request) {
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    throw new HttpError(415, 'Use application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'Request exceeds 256 KiB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    jsonDepth(result);
    return object(result);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON.');
  }
}
