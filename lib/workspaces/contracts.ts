/** Public v1 wire contract. JSON only; timestamps are Unix milliseconds. */
/**
 * Portable public contract for team workspaces. Browser code, API routes, integrations,
 * and storage all exchange these shapes, so changes here affect every producer and reader.
 */

/** JSON-compatible values are the only data allowed inside an artifact. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Role = 'owner' | 'editor' | 'viewer';
export type Workspace = {
  id: string;
  name: string;
  role: Role;
  created: number;
};
export type Member = {
  userId: string;
  displayName: string;
  role: Role;
  joined: number;
};
/** A workspace's reusable group code. `code` is the grouped display form. */
export type JoinCode = {
  id: string;
  code: string;
  role: 'editor' | 'viewer';
  expires: number;
  /** `null` when any number of people may join before it expires. */
  maxUses: number | null;
  uses: number;
  created: number;
};
export type ArtifactInput = {
  // `kind` and `schemaVersion` tell readers how to interpret immutable content.
  kind: string;
  schemaVersion: number;
  title: string;
  summary: string;
  content: { [key: string]: Json };
  /** Caller-declared processing metadata, never an authorization source. */
  provenance: { [key: string]: Json };
  parentIds: string[];
};
export type Artifact = ArtifactInput & {
  // These fields are stamped by the server and cannot be chosen by a publisher.
  id: string;
  workspaceId: string;
  createdBy: string;
  authorName: string;
  created: number;
  checksum: string;
};
export type ArtifactSummary = Omit<Artifact, 'content'>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type WorkspaceEvent = {
  sequence: number;
  type: string;
  actorId: string;
  subjectId: string;
  created: number;
};
export type CorpusDocument = {
  id: string;
  title: string;
  text: string;
  source: string;
};
export type CorpusContent = {
  documents: CorpusDocument[];
  method: string;
  originalBytes: number;
  storedTextBytes: number;
};
export const CORPUS_KIND = 'brief.corpus';
export const FOLD_KIND = 'brief.fold';
// D1 stores artifact JSON directly; this cap prevents unexpectedly large records.
export const MAX_REQUEST_BYTES = 262144;
