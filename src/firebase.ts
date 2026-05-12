import { getAccessToken } from './auth.js';

const API = 'https://firebaseremoteconfig.googleapis.com/v1';
const MGMT_API = 'https://firebase.googleapis.com/v1beta1';

export type RemoteConfigParameter = {
  defaultValue?: { value?: string; useInAppDefault?: boolean };
  conditionalValues?: Record<string, { value?: string; useInAppDefault?: boolean }>;
  description?: string;
  valueType?: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON';
};

export type RemoteConfigTemplate = {
  parameters?: Record<string, RemoteConfigParameter>;
  conditions?: unknown[];
  parameterGroups?: Record<string, unknown>;
  version?: { versionNumber?: string; updateTime?: string; updateUser?: { email?: string }; updateOrigin?: string; updateType?: string; description?: string };
  etag?: string;
};

export type FetchedTemplate = { template: RemoteConfigTemplate; etag: string };

async function authedFetch(project: string, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=UTF-8');
  headers.set('Accept-Encoding', 'gzip');
  const res = await fetch(`${API}/projects/${encodeURIComponent(project)}${path}`, { ...init, headers });
  return res;
}

export type FirebaseProjectInfo = {
  projectId: string;
  displayName?: string;
  projectNumber?: string;
  state?: string;
};

export async function listFirebaseProjects(): Promise<FirebaseProjectInfo[]> {
  const token = await getAccessToken();
  const out: FirebaseProjectInfo[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${MGMT_API}/projects`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw await asError(res, 'listFirebaseProjects');
    const j = (await res.json()) as { results?: FirebaseProjectInfo[]; nextPageToken?: string };
    if (j.results) out.push(...j.results);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function asError(res: Response, action: string): Promise<Error> {
  let body = '';
  try { body = await res.text(); } catch (_) { /* ignore */ }
  let message = `${action} failed: HTTP ${res.status}`;
  try {
    const j = JSON.parse(body);
    if (j?.error?.message) message += ` — ${j.error.message}`;
  } catch (_) { if (body) message += ` — ${body.slice(0, 300)}`; }
  return new Error(message);
}

export async function getTemplate(project: string): Promise<FetchedTemplate> {
  const res = await authedFetch(project, '/remoteConfig');
  if (!res.ok) throw await asError(res, 'getTemplate');
  const etag = res.headers.get('etag') || '';
  const template = (await res.json()) as RemoteConfigTemplate;
  return { template, etag };
}

export async function getTemplateAtVersion(project: string, versionNumber: number): Promise<FetchedTemplate> {
  const res = await authedFetch(project, `/remoteConfig?versionNumber=${encodeURIComponent(String(versionNumber))}`);
  if (!res.ok) throw await asError(res, `getTemplateAtVersion(${versionNumber})`);
  const etag = res.headers.get('etag') || '';
  const template = (await res.json()) as RemoteConfigTemplate;
  return { template, etag };
}

export async function publishTemplate(
  project: string,
  template: RemoteConfigTemplate,
  options: { ifMatch: string; validateOnly?: boolean } = { ifMatch: '*' }
): Promise<RemoteConfigTemplate> {
  const qs = options.validateOnly ? '?validate_only=true' : '';
  const res = await authedFetch(project, `/remoteConfig${qs}`, {
    method: 'PUT',
    body: JSON.stringify(template),
    headers: { 'If-Match': options.ifMatch },
  });
  if (!res.ok) throw await asError(res, options.validateOnly ? 'validateTemplate' : 'publishTemplate');
  return (await res.json()) as RemoteConfigTemplate;
}

export type VersionInfo = {
  versionNumber: string;
  updateTime: string;
  updateUser?: { email?: string; name?: string };
  updateOrigin?: string;
  updateType?: string;
  description?: string;
};

export async function listVersions(project: string, pageSize = 15): Promise<VersionInfo[]> {
  const res = await authedFetch(project, `/remoteConfig:listVersions?pageSize=${pageSize}`);
  if (!res.ok) throw await asError(res, 'listVersions');
  const j = (await res.json()) as { versions?: VersionInfo[] };
  return j.versions ?? [];
}

export function extractParamValue(template: RemoteConfigTemplate, key: string): {
  exists: boolean;
  parsed?: unknown;
  raw?: string;
  valueType?: RemoteConfigParameter['valueType'];
  description?: string;
  conditionalValues?: Record<string, unknown>;
} {
  const p = template.parameters?.[key];
  if (!p) return { exists: false };
  const raw = p.defaultValue?.value;
  let parsed: unknown = raw;
  if (p.valueType === 'JSON' && typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { /* leave as string */ }
  } else if (p.valueType === 'NUMBER' && typeof raw === 'string') {
    parsed = Number(raw);
  } else if (p.valueType === 'BOOLEAN' && typeof raw === 'string') {
    parsed = raw === 'true';
  }
  return {
    exists: true,
    parsed,
    raw,
    valueType: p.valueType,
    description: p.description,
    conditionalValues: p.conditionalValues as Record<string, unknown> | undefined,
  };
}

export function setParamValue(
  template: RemoteConfigTemplate,
  key: string,
  parsed: unknown,
  valueType: RemoteConfigParameter['valueType']
): void {
  const params = template.parameters ?? (template.parameters = {});
  const p = params[key];
  if (!p) throw new Error(`Parameter "${key}" does not exist in the remote template.`);
  const vt = valueType || p.valueType || 'STRING';
  let serialized: string;
  if (vt === 'JSON') serialized = JSON.stringify(parsed);
  else if (vt === 'NUMBER') serialized = String(parsed);
  else if (vt === 'BOOLEAN') serialized = parsed ? 'true' : 'false';
  else serialized = String(parsed);
  p.defaultValue = { value: serialized };
}
