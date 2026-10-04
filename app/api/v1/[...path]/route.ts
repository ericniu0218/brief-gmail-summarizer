import { getChatGPTUser, chatGPTSignInPath } from '@/app/chatgpt-auth';
import { HttpError, json, mutation, runtime } from '@/server/runtime';
import {
  integrationPrincipal,
  WorkspaceStore,
} from '@/server/workspaces/store';
import { canonical, hash, readBody } from '@/server/workspaces/validation';
import { compressText, foldCorpus } from '@/server/workspaces/processors';
import { gmailPreview } from '@/server/workspaces/gmail-adapter';
import { emailTaskDraft } from '@/server/workspaces/email-task';

/**
 * Versioned HTTP router for shared workspaces. It resolves a human or integration actor,
 * checks browser mutation origins, then delegates authorization and persistence to
 * `WorkspaceStore`.
 */
export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const db = runtime().DB;
    const authorization = request.headers.get('authorization');
    let actor;
    // Bearer tokens identify server integrations. Requests without one use the verified
    // signed-in human supplied by the hosting dispatcher.
    if (authorization !== null) {
      if (!authorization.startsWith('Bearer '))
        throw new HttpError(401, 'Use Bearer authentication.');
      actor = await integrationPrincipal(db, authorization.slice(7));
      if (request.headers.has('origin')) mutation(request);
    } else {
      const user = await getChatGPTUser();
      if (!user)
        return json(
          {
            error: 'Sign in to access team workspaces.',
            code: 'sign_in_required',
            requestId,
            signInUrl: chatGPTSignInPath('/team'),
          },
          401,
        );
      actor = {
        type: 'user' as const,
        id: user.userId,
        name: user.displayName,
      };
      if (request.method !== 'GET') mutation(request);
    }
    const store = new WorkspaceStore(db, actor);
    const url = new URL(request.url);
    const path = url.pathname
      .replace(/^\/api\/v1\/?/, '')
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = request.method;
    const key = request.headers.get('idempotency-key');
    const [root, ws, resource, id, action] = path;
    const body = () => readBody(request);
    // Route matching stays explicit so every endpoint has a visible method and permission.
    let result: unknown;
    let status = 200;
    if (root === 'workspaces' && path.length === 1) {
      if (method === 'GET') result = { items: await store.listWorkspaces() };
      else if (method === 'POST') {
        result = await store.createWorkspace((await body()).name);
        status = 201;
      } else throw new HttpError(405, 'Method not allowed.');
    } else if (root === 'tasks' && path.length === 1 && method === 'GET') {
      // Everything assigned to the caller, whichever workspace it lives in.
      result = { items: await store.myTasks() };
    } else if (root === 'join' && path.length === 1 && method === 'POST') {
      result = await store.join((await body()).token);
    } else if (
      root === 'workspaces' &&
      ws &&
      path.length >= 3 &&
      path.length <= 5
    ) {
      if (resource === 'artifacts' && path.length === 3 && method === 'GET')
        result = await store.listArtifacts(ws, url.searchParams);
      else if (
        resource === 'artifacts' &&
        path.length === 3 &&
        method === 'POST'
      ) {
        const saved = await store.publish(ws, await body(), key);
        result = saved;
        status = saved.replayed ? 200 : 201;
      } else if (
        resource === 'artifacts' &&
        path.length === 4 &&
        method === 'GET'
      )
        result = await store.getArtifact(ws, id);
      else if (
        resource === 'artifacts' &&
        path.length === 5 &&
        action === 'fold' &&
        method === 'POST'
      ) {
        await store.authorize(ws, 'write');
        const saved = await store.publish(
          ws,
          foldCorpus(await store.getArtifact(ws, id)),
          key,
        );
        result = saved;
        status = saved.replayed ? 200 : 201;
      } else if (
        resource === 'preview' &&
        path.length === 3 &&
        method === 'POST'
      ) {
        await store.authorize(ws, 'write');
        const data = await body();
        result = compressText(data.title, data.text);
      } else if (
        resource === 'capture' &&
        path.length === 3 &&
        method === 'POST'
      ) {
        await store.authorize(ws, 'write');
        if (actor.type !== 'user')
          throw new HttpError(
            403,
            'Only a signed-in user can share their Gmail snapshot.',
          );
        const data = await body();
        const preview = await gmailPreview(db, actor.id, data);
        const previewHash = await hash(canonical(preview));
        // Publishing must match the exact preview the user reviewed. If the inbox changed,
        // the user receives a new preview instead of sharing different text silently.
        if (data.publish === true) {
          if (data.previewHash !== previewHash)
            throw new HttpError(
              409,
              'The snapshot changed. Review a fresh preview before sharing.',
            );
          const saved = await store.publish(ws, preview, key);
          result = saved;
          status = saved.replayed ? 200 : 201;
        } else result = { preview, previewHash };
      } else if (
        resource === 'members' &&
        path.length === 3 &&
        method === 'GET'
      )
        result = { items: await store.members(ws) };
      else if (
        resource === 'members' &&
        path.length === 4 &&
        (method === 'PATCH' || method === 'DELETE')
      ) {
        await store.changeMember(
          ws,
          id,
          method === 'DELETE' ? null : (await body()).role,
        );
        result = { ok: true };
      } else if (resource === 'tasks' && path.length === 3) {
        if (method === 'GET') result = await store.tasks(ws);
        else if (method === 'POST') {
          result = await store.createTask(ws, await body(), key);
          status = 201;
        } else throw new HttpError(405, 'Method not allowed.');
      } else if (resource === 'tasks' && path.length === 4) {
        // An update names the version it edits; see `WorkspaceStore.updateTask`.
        if (method === 'PATCH') result = await store.updateTask(ws, id, await body());
        else if (method === 'DELETE') {
          await store.deleteTask(ws, id);
          result = { ok: true };
        } else throw new HttpError(405, 'Method not allowed.');
      } else if (
        resource === 'task-from-email' &&
        path.length === 3 &&
        method === 'POST'
      ) {
        await store.authorize(ws, 'write');
        if (actor.type !== 'user')
          throw new HttpError(
            403,
            'Only a signed-in user can turn their own mail into a task.',
          );
        const data = await body();
        const draft = await emailTaskDraft(db, actor.id, data);
        const draftHash = await hash(canonical(draft));
        if (data.create === true) {
          // The task is created from the draft a person actually read. If the mailbox has
          // been reclassified since, they review the new draft instead of silently adding
          // a task built from text nobody saw.
          if (data.draftHash !== draftHash)
            throw new HttpError(
              409,
              'This message changed. Review it again before adding the task.',
            );
          const saved = await store.createTask(
            ws,
            {
              title: data.title ?? draft.title,
              // Only the server's own text describes the message.
              detail: draft.detail,
              assigneeId: data.assigneeId ?? null,
              due: data.due === undefined ? draft.due : data.due,
            },
            key,
          );
          result = saved;
          status = 201;
        } else result = { draft, draftHash };
      } else if (resource === 'code' && path.length === 3) {
        // One live code per workspace, so it is a single resource, not a collection.
        if (method === 'GET') result = { code: await store.joinCode(ws) };
        else if (method === 'POST') {
          result = await store.createJoinCode(ws, await body());
          status = 201;
        } else if (method === 'DELETE') {
          await store.revokeJoinCode(ws);
          result = { ok: true };
        } else throw new HttpError(405, 'Method not allowed.');
      } else if (
        resource === 'invites' &&
        path.length === 3 &&
        method === 'GET'
      )
        result = { items: await store.invites(ws) };
      else if (
        resource === 'invites' &&
        path.length === 3 &&
        method === 'POST'
      ) {
        result = await store.createInvite(ws, (await body()).role);
        status = 201;
      } else if (
        resource === 'invites' &&
        path.length === 4 &&
        method === 'DELETE'
      ) {
        await store.revokeInvite(ws, id);
        result = { ok: true };
      } else if (resource === 'tokens' && path.length === 3 && method === 'GET')
        result = { items: await store.tokens(ws) };
      else if (
        resource === 'tokens' &&
        path.length === 3 &&
        method === 'POST'
      ) {
        result = await store.createToken(ws, await body());
        status = 201;
      } else if (
        resource === 'tokens' &&
        path.length === 4 &&
        method === 'DELETE'
      ) {
        await store.revokeToken(ws, id);
        result = { ok: true };
      } else if (resource === 'events' && path.length === 3 && method === 'GET')
        result = await store.events(ws, url.searchParams);
      else throw new HttpError(404, 'Endpoint not found.');
    } else throw new HttpError(404, 'Endpoint not found.');
    const response = json(result, status);
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500)
      console.error(
        'Workspace request failed',
        requestId,
        error instanceof Error ? error.name : 'UnknownError',
      );
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : 'Workspace request failed. Try again.',
        code: `http_${status}`,
        requestId,
      },
      status,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
