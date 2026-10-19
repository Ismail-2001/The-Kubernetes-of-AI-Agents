import http from "http";
import { AddressInfo } from "net";
import nock from "nock";
import { PolicyPlaneService } from "../service";
import { createPolicyHttpHandler } from "../http-api";

const OPA_HOST = "http://localhost:8181";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  server = http.createServer(createPolicyHttpHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  PolicyPlaneService.resetInstance();
  nock.cleanAll();
});

afterEach(() => {
  PolicyPlaneService.resetInstance();
  nock.cleanAll();
});

function workflowEnginePayload(): string {
  // Exactly what control-plane/workflow-engine POSTs today.
  return JSON.stringify({
    input: {
      subject: { namespace: "default", clearance: 2 },
      action: "execute",
      resource: { namespace: "default" },
    },
  });
}

describe("policy-plane HTTP /v1/data API", () => {
  it("returns OPA-shaped result for an allow decision", async () => {
    nock(OPA_HOST)
      .post("/v1/data/egaop/execution", (body) => {
        // Must normalize partial input: fill namespace/agentId/claims before hashing/caching.
        const input = (body as { input: Record<string, unknown> }).input;
        return (
          input["namespace"] === "default" &&
          input["agentId"] === "unknown" &&
          typeof input["claims"] === "object"
        );
      })
      .reply(200, { result: { allow: true, reason: "" } });

    const res = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: workflowEnginePayload(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { allow: boolean; reason: string } };
    expect(body.result.allow).toBe(true);
  });

  it("returns deny with reason from OPA", async () => {
    nock(OPA_HOST)
      .post("/v1/data/egaop/execution")
      .reply(200, {
        result: { allow: false, reason: "Sandbox agents cannot execute" },
      });

    const res = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: workflowEnginePayload(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { allow: boolean; reason: string } };
    expect(body.result.allow).toBe(false);
    expect(body.result.reason).toBe("Sandbox agents cannot execute");
  });

  it("fail-closes to deny when OPA is unreachable", async () => {
    nock(OPA_HOST)
      .post("/v1/data/egaop/execution")
      .replyWithError("ECONNREFUSED");

    const res = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: workflowEnginePayload(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { allow: boolean; reason: string } };
    expect(body.result.allow).toBe(false);
  });

  it("rejects a body with no input object (400)", async () => {
    const res = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects input missing subject.clearance (400)", async () => {
    const res = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {
          subject: { namespace: "default" },
          action: "execute",
          resource: { namespace: "default" },
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("404s unknown policy paths (no open proxy to arbitrary OPA data)", async () => {
    const res = await fetch(`${baseUrl}/v1/data/evil/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: workflowEnginePayload(),
    });
    expect(res.status).toBe(404);
  });

  it("405s GET on /v1/data", async () => {
    const res = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("serves /healthz and /readyz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("SERVING");
    expect(body.service).toBe("policy-plane");
  });

  it("caches identical inputs (one OPA call for two requests)", async () => {
    const scope = nock(OPA_HOST)
      .post("/v1/data/egaop/execution")
      .reply(200, { result: { allow: true, reason: "" } });

    const doReq = () =>
      fetch(`${baseUrl}/v1/data/egaop/execution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: workflowEnginePayload(),
      });

    const first = await doReq();
    const second = await doReq();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks().length).toBe(0);
  });

  it("does NOT reuse a cached allow across inputs differing only in nested values (regression guard at HTTP layer)", async () => {
    nock(OPA_HOST)
      .post("/v1/data/egaop/execution")
      .reply(200, { result: { allow: true, reason: "" } });
    nock(OPA_HOST)
      .post("/v1/data/egaop/execution")
      .reply(200, {
        result: { allow: false, reason: "clearance below required" },
      });

    const high = JSON.stringify({
      input: {
        subject: { namespace: "default", clearance: 3, metadata: { role: "admin" } },
        action: "execute",
        resource: { namespace: "default" },
      },
    });
    const low = JSON.stringify({
      input: {
        subject: { namespace: "default", clearance: 1, metadata: { role: "guest" } },
        action: "execute",
        resource: { namespace: "default" },
      },
    });

    const first = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: high,
    });
    const second = await fetch(`${baseUrl}/v1/data/egaop/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: low,
    });

    const firstBody = (await first.json()) as { result: { allow: boolean } };
    const secondBody = (await second.json()) as { result: { allow: boolean; reason: string } };
    expect(firstBody.result.allow).toBe(true);
    expect(secondBody.result.allow).toBe(false);
    expect(secondBody.result.reason).toBe("clearance below required");
  });
});
