import type { paths, components } from './openapi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProblemDetails = components['schemas']['ProblemDetails'];

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface EgaopClientConfig {
  baseUrl: string;
  token?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// EgaopClient
// ---------------------------------------------------------------------------

export class EgaopClient {
  private baseUrl: string;
  private token?: string;
  private timeout: number;

  constructor(config: EgaopClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeout = config.timeout ?? 30_000;
  }

  // ----- Auth helpers -------------------------------------------------------

  login(
    email: string,
    password: string
  ): Promise<components['schemas']['LoginResponse']> {
    return this.post('/api/auth/login', { email, password }, false);
  }

  setToken(token: string): void {
    this.token = token;
  }

  register(data: { email: string; password: string; name?: string }): Promise<void> {
    return this.post('/api/auth/register', data, false);
  }

  me(): Promise<{ id: string; email: string }> {
    return this.get('/api/auth/me');
  }

  changePassword(data: { currentPassword: string; newPassword: string }): Promise<void> {
    return this.post('/api/auth/change-password', data, true);
  }

  // ----- Agent methods ------------------------------------------------------

  listAgents(
    params: {
      namespace?: string;
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    } = {}
  ): Promise<components['schemas']['PaginatedResponse']> {
    const qs = new URLSearchParams();
    if (params.namespace) qs.set('namespace', params.namespace);
    if (params.status) qs.set('status', params.status);
    if (params.search) qs.set('search', params.search);
    if (params.page != null) qs.set('page', String(params.page));
    if (params.limit != null) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.get(`/api/agents${q ? '?' + q : ''}`);
  }

  getAgent(
    id: string,
    namespace?: string
  ): Promise<components['schemas']['Agent']> {
    const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return this.get(`/api/agents/${encodeURIComponent(id)}${qs}`);
  }

  createAgent(data: {
    name: string;
    namespace?: string;
    spec?: { model?: string; systemPrompt?: string; tools?: string[] };
  }): Promise<components['schemas']['ApiResponse']> {
    return this.post('/api/agents', data, true);
  }

  updateAgent(
    id: string,
    data: {
      namespace?: string;
      spec?: { model?: string; systemPrompt?: string; tools?: string[] };
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    }
  ): Promise<void> {
    return this.put(`/api/agents/${encodeURIComponent(id)}`, data, true);
  }

  deleteAgent(id: string): Promise<void> {
    return this.del(`/api/agents/${encodeURIComponent(id)}`);
  }

  // ----- Execution methods --------------------------------------------------

  runAgent(
    id: string,
    input?: { prompt?: string; systemPrompt?: string },
    namespace?: string
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input) body.input = input;
    if (namespace) body.namespace = namespace;
    return this.post(`/api/agents/${encodeURIComponent(id)}/run`, body, true);
  }

  listExecutions(
    agentId: string,
    params: { namespace?: string; page?: number; limit?: number } = {}
  ): Promise<components['schemas']['AgentExecution'][]> {
    const qs = new URLSearchParams();
    if (params.namespace) qs.set('namespace', params.namespace);
    if (params.page != null) qs.set('page', String(params.page));
    if (params.limit != null) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.get(
      `/api/agents/${encodeURIComponent(agentId)}/executions${q ? '?' + q : ''}`
    );
  }

  getExecution(id: string): Promise<components['schemas']['AgentExecution']> {
    return this.get(`/api/executions/${encodeURIComponent(id)}`);
  }

  // ----- Version methods ----------------------------------------------------

  listVersions(
    agentId: string,
    params: { namespace?: string; limit?: number } = {}
  ): Promise<components['schemas']['AgentVersion'][]> {
    const qs = new URLSearchParams();
    if (params.namespace) qs.set('namespace', params.namespace);
    if (params.limit != null) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.get(
      `/api/agents/${encodeURIComponent(agentId)}/versions${q ? '?' + q : ''}`
    );
  }

  getVersion(
    agentId: string,
    version: number,
    namespace?: string
  ): Promise<components['schemas']['AgentVersion']> {
    const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return this.get(
      `/api/agents/${encodeURIComponent(agentId)}/versions/${version}${qs}`
    );
  }

  rollback(
    agentId: string,
    data: { version: number; namespace?: string }
  ): Promise<void> {
    return this.post(
      `/api/agents/${encodeURIComponent(agentId)}/rollback`,
      data,
      true
    );
  }

  // ----- Namespace methods --------------------------------------------------

  listNamespaces(): Promise<components['schemas']['PaginatedResponse']> {
    return this.get('/api/namespaces');
  }

  getNamespace(name: string): Promise<components['schemas']['Namespace']> {
    return this.get(`/api/namespaces/${encodeURIComponent(name)}`);
  }

  createNamespace(data: {
    name: string;
    displayName?: string;
    tier?: 'sandbox' | 'production' | 'enterprise';
    quotas?: { maxAgents?: number; concurrentExecutions?: number; toolCallsPerMinute?: number };
  }): Promise<void> {
    return this.post('/api/namespaces', data, true);
  }

  updateNamespace(
    name: string,
    data: {
      displayName?: string;
      tier?: 'sandbox' | 'production' | 'enterprise';
      quotas?: { maxAgents?: number; concurrentExecutions?: number; toolCallsPerMinute?: number };
    }
  ): Promise<void> {
    return this.put(`/api/namespaces/${encodeURIComponent(name)}`, data, true);
  }

  deleteNamespace(name: string): Promise<void> {
    return this.del(`/api/namespaces/${encodeURIComponent(name)}`);
  }

  // ----- Trace methods ------------------------------------------------------

  listTraces(
    params: { namespace?: string; page?: number; limit?: number } = {}
  ): Promise<components['schemas']['Trace'][]> {
    const qs = new URLSearchParams();
    if (params.namespace) qs.set('namespace', params.namespace);
    if (params.page != null) qs.set('page', String(params.page));
    if (params.limit != null) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.get(`/api/traces${q ? '?' + q : ''}`);
  }

  getTrace(traceId: string): Promise<components['schemas']['Trace']> {
    return this.get(`/api/traces/${encodeURIComponent(traceId)}`);
  }

  // ----- Metrics ------------------------------------------------------------

  getMetrics(): Promise<components['schemas']['Metrics']> {
    return this.get('/api/metrics');
  }

  getSlos(window?: number): Promise<components['schemas']['SLOSnapshot']> {
    const qs = window != null ? `?window=${window}` : '';
    return this.get(`/api/slos${qs}`);
  }

  // ----- Audit --------------------------------------------------------------

  listAuditLog(
    params: {
      page?: number;
      limit?: number;
      event_type?: string;
      severity?: string;
      actor_id?: string;
      search?: string;
    } = {}
  ): Promise<components['schemas']['PaginatedResponse']> {
    const qs = new URLSearchParams();
    if (params.page != null) qs.set('page', String(params.page));
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.event_type) qs.set('event_type', params.event_type);
    if (params.severity) qs.set('severity', params.severity);
    if (params.actor_id) qs.set('actor_id', params.actor_id);
    if (params.search) qs.set('search', params.search);
    const q = qs.toString();
    return this.get(`/api/audit-log${q ? '?' + q : ''}`);
  }

  // ----- Users --------------------------------------------------------------

  listUsers(
    params: { page?: number; limit?: number; role?: string; search?: string } = {}
  ): Promise<components['schemas']['PaginatedResponse']> {
    const qs = new URLSearchParams();
    if (params.page != null) qs.set('page', String(params.page));
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.role) qs.set('role', params.role);
    if (params.search) qs.set('search', params.search);
    const q = qs.toString();
    return this.get(`/api/users${q ? '?' + q : ''}`);
  }

  // ----- Health -------------------------------------------------------------

  healthCheck(): Promise<{ status: string }> {
    return this.get('/health');
  }

  // ----- Core HTTP -----------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(
    path: string,
    body: unknown,
    auth: boolean
  ): Promise<T> {
    return this.request<T>('POST', path, { body, auth });
  }

  private async put<T>(
    path: string,
    body: unknown,
    auth: boolean
  ): Promise<T> {
    return this.request<T>('PUT', path, { body, auth });
  }

  private async del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean } = {}
  ): Promise<T> {
    const { body, auth = true } = opts;
    const maxRetries = 3;
    let attempt = 0;

    while (attempt <= maxRetries) {
      const requestId = generateRequestId();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      };

      if (auth && this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body != null ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Handle rate limiting with retry-after
        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
          if (attempt < maxRetries) {
            attempt++;
            await delay(waitMs);
            continue;
          }
          await throwProblemError(res);
        }

        // Retry on 5xx
        if (res.status >= 500 && attempt < maxRetries) {
          attempt++;
          const backoff = Math.pow(2, attempt) * 200;
          await delay(backoff);
          continue;
        }

        // 204 No Content
        if (res.status === 204 || res.headers.get('content-length') === '0') {
          return undefined as T;
        }

        if (!res.ok) {
          await throwProblemError(res);
        }

        // Try to parse JSON; fall back to undefined
        const text = await res.text();
        if (!text) return undefined as T;
        return JSON.parse(text) as T;
      } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new EgaopError({
            type: 'urn:e-gaop:error:TIMEOUT',
            title: 'Request Timeout',
            status: 408,
            detail: `Request to ${path} timed out after ${this.timeout}ms`,
            instance: path,
            requestId,
          });
        }
        if (err instanceof EgaopError) throw err;
        throw err;
      }
    }

    throw new EgaopError({
      type: 'urn:e-gaop:error:RETRY_EXHAUSTED',
      title: 'Retries Exhausted',
      status: 500,
      detail: `All ${maxRetries} retries failed for ${method} ${path}`,
      instance: path,
    });
  }
}

// ---------------------------------------------------------------------------
// EgaopError
// ---------------------------------------------------------------------------

export async function throwProblemError(res: Response): Promise<never> {
  let problem: ProblemDetails;
  try {
    problem = await res.json();
  } catch {
    problem = {
      type: 'urn:e-gaop:error:UNKNOWN',
      title: res.statusText || 'Unknown Error',
      status: res.status,
      detail: `HTTP ${res.status} from ${res.url}`,
      instance: res.url,
    };
  }
  throw new EgaopError(problem);
}

export class EgaopError extends Error {
  readonly type: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly traceId?: string;
  readonly code?: string;
  readonly requestId?: string;

  constructor(problem: ProblemDetails & { requestId?: string }) {
    super(problem.detail);
    this.name = 'EgaopError';
    this.type = problem.type;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.traceId = problem.traceId;
    this.code = problem.code;
    this.requestId = (problem as any).requestId;
  }
}
