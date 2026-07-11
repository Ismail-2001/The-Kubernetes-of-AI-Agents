import { Connection, Client } from "@temporalio/client";
import fs from "fs";
import {
  reactWorkflow,
  cancelSignal,
  statusQuery,
} from "./workflows/react-workflow";
import { hitlApprovalGate, approvalSignal } from "./workflows/hitl-gate";
import type {
  AgentExecutionInput,
  AgentResult,
  WorkflowStatus,
  ApprovalDecision,
  HITLApprovalInput,
  HITLResult,
} from "./types";

// ─── Singleton State ───────────────────────────────────────────────────────

let clientInstance: Client | null = null;
let connectionInstance: Connection | null = null;

// ─── Connection Setup ──────────────────────────────────────────────────────

interface TemporalConnectionOptions {
  address: string;
  tls?: {
    clientCertPair: {
      crt: Buffer;
      key: Buffer;
    };
  };
}

async function getConnection(): Promise<Connection> {
  if (connectionInstance) return connectionInstance;

  const address = process.env.TEMPORAL_ADDRESS || "localhost:7233";
  const options: TemporalConnectionOptions = { address };

  // Add mTLS if configured
  if (process.env.TEMPORAL_TLS_CERT && process.env.TEMPORAL_TLS_KEY) {
    const tlsCert = fs.readFileSync(process.env.TEMPORAL_TLS_CERT);
    const tlsKey = fs.readFileSync(process.env.TEMPORAL_TLS_KEY);
    options.tls = {
      clientCertPair: {
        crt: tlsCert,
        key: tlsKey,
      },
    };
  }

  connectionInstance = await Connection.connect(options);
  return connectionInstance;
}

async function getClient(): Promise<Client> {
  if (clientInstance) return clientInstance;

  const connection = await getConnection();
  const namespace = process.env.TEMPORAL_NAMESPACE || "egaop";

  clientInstance = new Client({ connection, namespace });
  return clientInstance;
}

// ─── Workflow Client API ───────────────────────────────────────────────────

export async function startAgentExecution(
  input: AgentExecutionInput
): Promise<{ workflowId: string; runId: string }> {
  const client = await getClient();
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE || "agent-execution";
  const workflowId = `agent-exec-${input.executionId}`;

  const handle = await client.workflow.start(reactWorkflow, {
    args: [input],
    taskQueue,
    workflowId,
    workflowExecutionTimeout: "30 minutes",
  });

  return {
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
  };
}

export async function cancelExecution(
  workflowId: string
): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(cancelSignal);
}

export async function getStatus(
  workflowId: string
): Promise<WorkflowStatus> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  return handle.query(statusQuery);
}

export async function waitForResult(
  workflowId: string,
  timeoutMs: number = 30 * 60 * 1000
): Promise<AgentResult> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);

  const result = await Promise.race(
    [
      handle.result(),
      new Promise<AgentResult>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Workflow timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ] as Array<Promise<AgentResult>>
  );

  return result;
}

// ─── HITL Client API ───────────────────────────────────────────────────────

export async function startHITLApproval(
  input: HITLApprovalInput
): Promise<{ workflowId: string }> {
  const client = await getClient();
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE || "agent-execution";
  const workflowId = `hitl-approval-${input.executionId}`;

  const handle = await client.workflow.start(hitlApprovalGate, {
    args: [input],
    taskQueue,
    workflowId,
    workflowExecutionTimeout: "25 hours",
  });

  return { workflowId: handle.workflowId };
}

export async function sendApprovalDecision(
  workflowId: string,
  decision: ApprovalDecision
): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(approvalSignal, decision);
}

// ─── Singleton Cleanup ─────────────────────────────────────────────────────

export async function closeClient(): Promise<void> {
  if (clientInstance) {
    clientInstance = null;
  }
  if (connectionInstance) {
    connectionInstance.close();
    connectionInstance = null;
  }
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

process.on("SIGTERM", async () => {
  await closeClient();
});

process.on("SIGINT", async () => {
  await closeClient();
});
