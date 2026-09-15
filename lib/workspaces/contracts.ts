/** Public v1 wire contract. JSON only; timestamps are Unix milliseconds. */
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
export type ArtifactInput = {
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
export const MAX_REQUEST_BYTES = 262144;
