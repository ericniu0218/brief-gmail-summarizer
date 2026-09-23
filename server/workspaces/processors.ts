import {
  CORPUS_KIND,
  FOLD_KIND,
  type Artifact,
  type ArtifactInput,
  type CorpusDocument,
  type Json,
} from '@/lib/workspaces/contracts';
import { corpusDocuments, integer, string } from './validation';
import { HttpError } from '../runtime';
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/** Deterministic, lossy extractive compression. No remote model calls. */
export function compressText(title: unknown, text: unknown): ArtifactInput {
  const name = string(title, 'Title');
  const source = string(text, 'Source text', 120000);
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 200)
    throw new HttpError(400, 'Use at most 200 paragraphs per corpus.');
  const documents: CorpusDocument[] = paragraphs.map((p, i) => ({
    id: `doc-${i + 1}`,
    title: `${name} · ${i + 1}`,
    source: 'Text import',
    text: p.replace(/\s+/g, ' ').slice(0, 500),
  }));
  return {
    kind: CORPUS_KIND,
    schemaVersion: 1,
    title: name,
    summary: `${documents.length} passages, compressed with a 500-character extract per passage.`,
    content: {
      documents: documents as unknown as Json,
      method: 'extractive-v1',
      originalBytes: bytes(source),
      storedTextBytes: bytes(documents.map((d) => d.text).join('\n\n')),
    },
    provenance: { adapter: 'text', processor: 'extractive-v1', lossy: true },
    parentIds: [],
  };
}
export function foldCorpus(parent: Artifact): ArtifactInput {
  if (parent.kind !== CORPUS_KIND || parent.schemaVersion !== 1)
    throw new HttpError(400, 'This processor requires a v1 corpus.');
  const documents = corpusDocuments(parent.content.documents);
  const buckets = new Map<string, CorpusDocument[]>();
  for (const d of documents) {
    const bucket = buckets.get(d.source) ?? [];
    bucket.push(d);
    buckets.set(d.source, bucket);
  }
  // Bounded summaries retain exact document IDs for retrieving full stored extracts.
  const groups = [...buckets].map(([source, docs]) => ({
    source,
    documentIds: docs.map((d) => d.id),
    text: docs
      .map((d) => `${d.title}: ${d.text.slice(0, 240)}`)
      .join('\n')
      .slice(0, 12000),
  }));
  return {
    kind: FOLD_KIND,
    schemaVersion: 1,
    title: `${parent.title.slice(0, 145)} · Fold`,
    summary: `${documents.length} documents grouped into ${groups.length} source ${groups.length === 1 ? 'group' : 'groups'}.`,
    content: {
      method: 'source-fold-v1',
      groups,
      documentCount: documents.length,
    },
    provenance: {
      adapter: 'brief',
      processor: 'source-fold-v1',
      parentChecksum: parent.checksum,
      lossy: true,
    },
    parentIds: [parent.id],
  };
}
export function selectedIds(value: unknown) {
  if (!Array.isArray(value))
    throw new HttpError(400, 'Choose message IDs to share.');
  integer(value.length, 'message count', 1, 60);
  return [...new Set(value.map((id) => string(id, 'Message ID')))];
}
