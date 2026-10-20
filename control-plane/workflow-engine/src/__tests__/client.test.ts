import {
  startAgentExecution,
  cancelExecution,
  getStatus,
  waitForResult,
  startHITLApproval,
  sendApprovalDecision,
  closeClient,
} from "../temporal/client";

jest.mock("fs", () => ({
  readFileSync: jest.fn().mockReturnValue(Buffer.from("fake-cert")),
}));

jest.mock("@temporalio/workflow", () => {
  const activities: Record<string, jest.Mock> = {};
  class ApplicationFailure extends Error {}
  return {
    proxyActivities: jest.fn().mockImplementation(() => {
      return new Proxy(activities, {
        get: (target, prop) => {
          if (typeof prop !== "string") return undefined;
          if (!(prop in target)) target[prop] = jest.fn();
          return target[prop];
        },
      });
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    setHandler: jest.fn(),
    defineSignal: jest.fn((name: string) => name),
    defineQuery: jest.fn((name: string) => name),
    workflowInfo: jest.fn().mockReturnValue({
      startTime: new Date("2026-01-01T00:00:00.000Z"),
    }),
    condition: jest.fn(),
    ApplicationFailure,
  };
});

const mockHandle = {
  workflowId: "agent-exec-exec-1",
  firstExecutionRunId: "run-1",
  signal: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue({
    iteration: 1,
    lastAction: "final_answer",
    startTime: "2026-01-01T00:00:00.000Z",
  }),
  result: jest.fn().mockResolvedValue({
    status: "SUCCEEDED",
    output: "ok",
    totalCost: "$0.001000",
    iterations: 1,
    toolCalls: [],
  }),
};

const mockWorkflow = {
  start: jest.fn().mockImplementation((_wf: any, opts: any) => {
    return Promise.resolve({ ...mockHandle, workflowId: opts.workflowId });
  }),
  getHandle: jest.fn().mockReturnValue(mockHandle),
};

jest.mock("@temporalio/client", () => {
  (globalThis as any).__mockTemporalClose = jest.fn();
  return {
    Connection: {
      connect: jest.fn().mockResolvedValue({ close: (globalThis as any).__mockTemporalClose }),
    },
    Client: jest.fn().mockImplementation(() => ({
      workflow: mockWorkflow,
    })),
  };
});

const mockConnection = { close: (globalThis as any).__mockTemporalClose };

import { Connection, Client } from "@temporalio/client";

describe("temporal client", () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    await closeClient();
    process.env = { ...savedEnv };
    jest.clearAllMocks();
  });

  it("starts an agent execution and returns workflow and run ids", async () => {
    const result = await startAgentExecution({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "test",
    });

    expect(result).toEqual({ workflowId: "agent-exec-exec-1", runId: "run-1" });
    expect(Client).toHaveBeenCalledTimes(1);
    expect(Connection.connect).toHaveBeenCalledWith({ address: "localhost:7233" });
    expect(mockWorkflow.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ taskQueue: "agent-execution" })
    );
  });

  it("reuses the client singleton across calls", async () => {
    await startAgentExecution({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "test",
    });
    await startAgentExecution({
      agentId: "agent-1",
      executionId: "exec-2",
      namespace: "test",
    });

    expect(Connection.connect).toHaveBeenCalledTimes(1);
    expect(Client).toHaveBeenCalledTimes(1);
    expect(mockWorkflow.start).toHaveBeenCalledTimes(2);
  });

  it("connects with mTLS when cert env vars are set", async () => {
    process.env.TEMPORAL_TLS_CERT = "test-fixtures/cert.pem";
    process.env.TEMPORAL_TLS_KEY = "test-fixtures/key.pem";
    process.env.TEMPORAL_ADDRESS = "temporal:7233";

    await startAgentExecution({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "test",
    });

    expect(Connection.connect).toHaveBeenCalledWith({
      address: "temporal:7233",
      tls: {
        clientCertPair: {
          crt: expect.any(Buffer),
          key: expect.any(Buffer),
        },
      },
    });
  });

  it("cancels an execution by signaling the workflow", async () => {
    await cancelExecution("agent-exec-exec-1");

    expect(mockWorkflow.getHandle).toHaveBeenCalledWith("agent-exec-exec-1");
    expect(mockHandle.signal).toHaveBeenCalledWith("cancel");
  });

  it("queries workflow status", async () => {
    const status = await getStatus("agent-exec-exec-1");

    expect(mockHandle.query).toHaveBeenCalled();
    expect(status.lastAction).toBe("final_answer");
  });

  it("waits for a workflow result", async () => {
    const result = await waitForResult("agent-exec-exec-1");

    expect(result.status).toBe("SUCCEEDED");
    expect(mockHandle.result).toHaveBeenCalled();
  });

  it("rejects with a timeout when the result never arrives", async () => {
    // Real short timer: waitForResult arms its setTimeout only after the
    // awaited getClient() resolves, so fake timers ran before the timer
    // existed and the test hung (it was previously skipped for this).
    mockHandle.result.mockReturnValueOnce(
      new Promise(() => {
        // never resolves
      })
    );

    await expect(waitForResult("agent-exec-exec-1", 50)).rejects.toThrow(
      "Workflow timeout after 50ms",
    );
  }, 8000);

  it("starts a HITL approval workflow", async () => {
    const result = await startHITLApproval({
      agentId: "agent-1",
      executionId: "exec-hitl",
      namespace: "test",
      toolName: "stripe.charges.create",
      toolArgs: { amount: 5000 },
    });

    expect(result).toEqual({ workflowId: "hitl-approval-exec-hitl" });
    expect(mockWorkflow.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ workflowId: "hitl-approval-exec-hitl" })
    );
  });

  it("sends an approval decision to a HITL workflow", async () => {
    await sendApprovalDecision("hitl-approval-exec-hitl", {
      approver: "admin@example.com",
      decision: "approve",
      reason: "ok",
    });

    expect(mockHandle.signal).toHaveBeenCalledWith("approval", {
      approver: "admin@example.com",
      decision: "approve",
      reason: "ok",
    });
  });

  it("closes the connection on closeClient", async () => {
    await startAgentExecution({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "test",
    });
    await closeClient();

    expect(mockConnection.close).toHaveBeenCalled();
  });
});
