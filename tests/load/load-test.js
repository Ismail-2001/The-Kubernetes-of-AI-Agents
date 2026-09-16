#!/usr/bin/env bash
# E-GAOP Load Test — k6 script
# Run: k6 run tests/load/load-test.js
# Requires: k6 (https://grafana.com/docs/k6/latest/)

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

const errorRate = new Rate("errors");
const latencyP95 = new Trend("latency_p95");
const requestCount = new Counter("total_requests");

export const options = {
  stages: [
    { duration: "30s", target: 10 },   // ramp up to 10 VUs
    { duration: "1m", target: 25 },    // ramp to 25 VUs
    { duration: "2m", target: 50 },    // sustain 50 VUs
    { duration: "1m", target: 25 },    // scale down
    { duration: "30s", target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
  },
};

let authToken = null;

function login() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: "source@egaop.io", password: "SourceBuild123!" }),
    { headers: { "Content-Type": "application/json" } }
  );
  if (res.status === 200) {
    const body = JSON.parse(res.body);
    authToken = body.data?.token;
  }
  return res;
}

function authHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
  };
}

export function setup() {
  const loginRes = login();
  check(loginRes, { "login successful": (r) => r.status === 200 });
  return { token: authToken };
}

export default function () {
  const headers = authToken ? authHeaders() : { headers: { "Content-Type": "application/json" } };

  // 1. Health check (no auth)
  const healthRes = http.get(`${BASE_URL}/healthz`, { tags: { endpoint: "healthz" } });
  check(healthRes, { "healthz 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 2. List agents
  const agentsRes = http.get(`${BASE_URL}/api/agents`, headers);
  check(agentsRes, { "agents 200": (r) => r.status === 200 });
  requestCount.add(1);
  errorRate.add(agentsRes.status !== 200);

  // 3. List namespaces
  const nsRes = http.get(`${BASE_URL}/api/namespaces`, headers);
  check(nsRes, { "namespaces 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 4. Namespace health
  const health2 = http.get(`${BASE_URL}/api/namespaces/health`, headers);
  check(health2, { "namespace health 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 5. Audit log
  const auditRes = http.get(`${BASE_URL}/api/audit-log?limit=10`, headers);
  check(auditRes, { "audit-log 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 6. Metrics
  const metricsRes = http.get(`${BASE_URL}/api/metrics`, headers);
  check(metricsRes, { "metrics 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 7. SLOs
  const sloRes = http.get(`${BASE_URL}/api/slos`, headers);
  check(sloRes, { "slos 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 8. Users
  const usersRes = http.get(`${BASE_URL}/api/users`, headers);
  check(usersRes, { "users 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 9. Notification channels
  const channelsRes = http.get(`${BASE_URL}/api/notification-channels`, headers);
  check(channelsRes, { "channels 200": (r) => r.status === 200 });
  requestCount.add(1);

  // 10. Policies
  const policiesRes = http.get(`${BASE_URL}/api/policies`, headers);
  check(policiesRes, { "policies 200": (r) => r.status === 200 });
  requestCount.add(1);

  sleep(1);
}

export function teardown(data) {
  // Optional: logout
  if (data.token) {
    http.post(`${BASE_URL}/api/auth/logout`, null, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
  }
}
