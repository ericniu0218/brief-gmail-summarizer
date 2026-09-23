import type {
  Artifact,
  ArtifactInput,
  ArtifactSummary,
  Page,
  WorkspaceEvent,
} from './contracts';
export class WorkspaceApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
    public signInUrl?: string,
  ) {
    super(message);
  }
}
/** Use only on a trusted integration server when token is provided. Never embed a key in a browser bundle. */
export class WorkspaceClient {
  constructor(
    private options: {
      baseUrl?: string;
      token?: string;
      sitesAuthorization?: string;
      fetch?: typeof fetch;
    } = {},
  ) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (this.options.token)
      headers.set('Authorization', `Bearer ${this.options.token}`);
    if (this.options.sitesAuthorization)
      headers.set(
        'OAI-Sites-Authorization',
        `Bearer ${this.options.sitesAuthorization}`,
      );
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl?.replace(/\/$/, '') ?? ''}/api/v1/${path}`,
      { ...init, headers, cache: 'no-store', redirect: 'error' },
    );
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new WorkspaceApiError(
        response.status,
        'The host requires sign-in or has not published the workspace API yet.',
      );
    const value = (await response.json()) as {
      error?: string;
      requestId?: string;
      signInUrl?: string;
    };
    if (!response.ok)
      throw new WorkspaceApiError(
        response.status,
        value.error ?? 'Request failed.',
        value.requestId,
        value.signInUrl,
      );
    return value as T;
  }
  list(workspaceId: string, params = new URLSearchParams()) {
    return this.request<Page<ArtifactSummary>>(
      `workspaces/${encodeURIComponent(workspaceId)}/artifacts?${params}`,
    );
  }
  get(workspaceId: string, id: string) {
    return this.request<Artifact>(
      `workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(id)}`,
    );
  }
  publish(
    workspaceId: string,
    artifact: ArtifactInput,
    idempotencyKey: string,
  ) {
    return this.request<{ artifact: Artifact; replayed: boolean }>(
      `workspaces/${encodeURIComponent(workspaceId)}/artifacts`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(artifact),
      },
    );
  }
  fold(workspaceId: string, id: string, idempotencyKey: string) {
    return this.request<{ artifact: Artifact; replayed: boolean }>(
      `workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(id)}/fold`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }
  events(workspaceId: string, after = 0) {
    return this.request<{
      items: WorkspaceEvent[];
      nextAfter: number;
      hasMore: boolean;
    }>(`workspaces/${encodeURIComponent(workspaceId)}/events?after=${after}`);
  }
}
