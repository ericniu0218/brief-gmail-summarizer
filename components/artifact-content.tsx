import {
  CORPUS_KIND,
  FOLD_KIND,
  type ArtifactInput,
  type CorpusDocument,
} from '@/lib/workspaces/contracts';
/** Unknown integration kinds remain readable without requiring a UI deployment. */
export function ArtifactContent({ artifact }: { artifact: ArtifactInput }) {
  if (artifact.kind === CORPUS_KIND && artifact.schemaVersion === 1) {
    const docs = artifact.content.documents as unknown as CorpusDocument[];
    const original = Number(artifact.content.originalBytes);
    const stored = Number(artifact.content.storedTextBytes);
    return (
      <div className="team-artifact-content">
        <p className="team-meta">
          {docs.length} documents · {stored.toLocaleString()} text bytes
          {original > 0
            ? ` · ${Math.max(0, Math.round((1 - stored / original) * 100))}% text reduction`
            : ''}
        </p>
        {docs.map((d) => (
          <article key={d.id}>
            <small>
              {d.source} · {d.id}
            </small>
            <h3>{d.title}</h3>
            <p>{d.text}</p>
          </article>
        ))}
      </div>
    );
  }
  if (artifact.kind === FOLD_KIND && artifact.schemaVersion === 1) {
    const groups = artifact.content.groups as unknown as {
      source: string;
      text: string;
      documentIds: string[];
    }[];
    return (
      <div className="team-artifact-content">
        {groups.map((g, index) => (
          <article key={index}>
            <h3>{g.source}</h3>
            <p>{g.text}</p>
            <small>Sources: {g.documentIds.join(', ')}</small>
          </article>
        ))}
      </div>
    );
  }
  return (
    <pre className="team-json">{JSON.stringify(artifact.content, null, 2)}</pre>
  );
}
