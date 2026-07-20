import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Custom metrics ───────────────────────────────────────────────────────
const errorRate = new Rate('errors');
const requestRate = new Rate('requests_per_sec');
const authDuration = new Trend('auth_duration_ms');
const agentCrudDuration = new Trend('agent_crud_duration_ms');
const executionDuration = new Trend('execution_duration_ms');
const healthDuration = new Trend('health_duration_ms');

// ─── SLO thresholds ───────────────────────────────────────────────────────
export const thresholds = {
  http_req_duration:      ['p(95)<1000', 'p(99)<2000', 'max<5000'],
  http_req_failed:        ['rate<0.01'],
  health_duration_ms:     ['p(95)<100',  'p(99)<200'],
  auth_duration_ms:       ['p(95)<500',  'p(99)<1000'],
  agent_crud_duration_ms: ['p(95)<1000', 'p(99)<2000'],
  execution_duration_ms:  ['p(95)<3000', 'p(99)<5000'],
  errors:                 ['rate<0.01'],
};

// ─── Configuration ────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const TEST_USER = {
  email: `k6-test-${__ENV.K6_CLUSTER_ID || 'default'}@egaop.io`,
  password: 'k6-test-load-2026',
  name: `k6-load-test-${__ENV.K6_CLUSTER_ID || 'default'}`,
};
const JWT_CACHE = { token: null, expiresAt: 0 };

function getHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function ensureUser() {
  // Register — may 409 if already exists, that's fine
  const regPayload = JSON.stringify(TEST_USER);
  http.post(`${BASE_URL}/api/auth/register`, regPayload, {
    headers: getHeaders(),
    tags: { name: 'register' },
  });
}

function login() {
  const now = Date.now();
  if (JWT_CACHE.token && JWT_CACHE.expiresAt > now + 60000) return JWT_CACHE.token;

  const payload = JSON.stringify({
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  const res = http.post(`${BASE_URL}/api/auth/login`, payload, {
    headers: getHeaders(),
    tags: { name: 'login' },
  });
  check(res, { 'login succeeded': (r) => r.status === 200 || r.status === 201 });
  if (res.status === 200 || res.status === 201) {
    const body = res.json();
    JWT_CACHE.token = body.data?.token || body.token;
    JWT_CACHE.expiresAt = now + 300_000;
  }
  return JWT_CACHE.token;
}

function createAgent(token, name) {
  const payload = JSON.stringify({
    name: `agent-${name}`,
    namespace: 'default',
    spec: {
      description: `Load test agent ${name}`,
      model: 'gpt-4o-mini',
      prompt: 'You are a helpful assistant.',
      tools: ['file_read', 'file_write'],
      maxIterations: 3,
      timeout: '30s',
    },
  });
  const res = http.post(`${BASE_URL}/api/agents`, payload, {
    headers: getHeaders(token),
    tags: { name: 'create_agent' },
  });
  check(res, { 'agent created': (r) => r.status === 201 });
  return res.status === 201;
}

function listAgents(token) {
  const res = http.get(`${BASE_URL}/api/agents?namespace=default&limit=50`, {
    headers: getHeaders(token),
    tags: { name: 'list_agents' },
  });
  check(res, { 'agents listed': (r) => r.status === 200 });
  if (res.status === 200) {
    const body = res.json();
    return body.data?.items || [];
  }
  return [];
}

function getMetrics(token) {
  const res = http.get(`${BASE_URL}/api/metrics`, {
    headers: getHeaders(token),
    tags: { name: 'get_metrics' },
  });
  check(res, { 'metrics fetched': (r) => r.status === 200 });
}

function listNamespaces(token) {
  const res = http.get(`${BASE_URL}/api/namespaces`, {
    headers: getHeaders(token),
    tags: { name: 'list_namespaces' },
  });
  check(res, { 'namespaces listed': (r) => r.status === 200 });
}

function triggerRun(token, agentId) {
  const payload = JSON.stringify({
    input: { prompt: 'Write "hello world" to /tmp/test.txt' },
    namespace: 'default',
  });
  const res = http.post(`${BASE_URL}/api/agents/${agentId}/run`, payload, {
    headers: getHeaders(token),
    tags: { name: 'trigger_run' },
  });
  check(res, { 'run triggered': (r) => r.status === 200 || r.status === 202 });
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

export const scenarios = {
  smoke: {
    executor: 'per-vu-iterations',
    vus: 1,
    iterations: 1,
    maxDuration: '30s',
    tags: { scenario: 'smoke' },
    exec: 'smokeTest',
  },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 20 },
      { duration: '3m', target: 20 },
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '30s',
    tags: { scenario: 'load' },
    exec: 'loadTest',
  },
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 20 },
      { duration: '2m', target: 50 },
      { duration: '2m', target: 100 },
      { duration: '2m', target: 150 },
      { duration: '2m', target: 200 },
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '30s',
    tags: { scenario: 'stress' },
    exec: 'loadTest',
  },
  soak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '5m', target: 30 },
      { duration: '60m', target: 30 },
      { duration: '5m', target: 0 },
    ],
    gracefulRampDown: '30s',
    tags: { scenario: 'soak' },
    exec: 'loadTest',
  },
};

// ─── Smoke test: verify every endpoint works ───────────────────────────────
export function smokeTest() {
  group('health', () => {
    const t = Date.now();
    const res = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
    healthDuration.add(Date.now() - t);
    check(res, { 'health returns 200': (r) => r.status === 200 });
  });

  group('auth', () => {
    ensureUser();
    const t = Date.now();
    const token = login();
    authDuration.add(Date.now() - t);
    check(token, { 'got JWT token': (t) => t && t.length > 0 });
  });

  const token = JWT_CACHE.token;
  if (!token) return;

  group('namespaces', () => {
    const t = Date.now();
    listNamespaces(token);
    authDuration.add(Date.now() - t);
  });

  group('agent CRUD', () => {
    const t = Date.now();
    createAgent(token, 'smoke-test');
    agentCrudDuration.add(Date.now() - t);

    const items = listAgents(token);
    if (items.length > 0) {
      const t2 = Date.now();
      triggerRun(token, items[0].id);
      executionDuration.add(Date.now() - t2);
    }
  });

  group('metrics', () => {
    getMetrics(token);
  });
}

// ─── Load / stress / soak test: steady realistic traffic ───────────────────
export function loadTest() {
  // Ensure user exists on first iteration per VU
  if (__ITER === 0) ensureUser();
  const token = login();
  if (!token) {
    errorRate.add(1);
    return;
  }

  const agents = listAgents(token);

  // Every iteration: health (always) + mix of auth, CRUD, executions
  group('health', () => {
    const t = Date.now();
    http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
    healthDuration.add(Date.now() - t);
  });

  if (__ITER % 10 === 0) {
    group('register', () => {
      const t = Date.now();
      ensureUser();
      authDuration.add(Date.now() - t);
    });
  }

  if (__ITER % 5 === 0) {
    group('create agent', () => {
      const t = Date.now();
      createAgent(token, `${__VU}-${__ITER}`);
      agentCrudDuration.add(Date.now() - t);
    });
  }

  if (__ITER % 3 === 0) {
    group('list agents', () => {
      const t = Date.now();
      const items = listAgents(token);
      if (items.length > 0) {
        const t2 = Date.now();
        triggerRun(token, items[0].id);
        executionDuration.add(Date.now() - t2);
      }
      agentCrudDuration.add(Date.now() - t);
    });
  }

  if (__ITER % 7 === 0) {
    group('namespaces', () => {
      listNamespaces(token);
    });
    group('metrics', () => {
      getMetrics(token);
    });
  }

  errorRate.add(0);
  sleep(Math.random() * 0.5 + 0.3);
}

// ─── Default export (runs all scenarios) ───────────────────────────────────
export default function () {
  loadTest();
}
