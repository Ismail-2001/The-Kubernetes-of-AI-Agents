import {
  proxyActivities,
  setHandler,
  defineSignal,
  ApplicationFailure,
  condition,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
  HITLApprovalInput,
  ApprovalDecision,
  HITLResult,
} from "../types";

// ─── Activity Proxies ──────────────────────────────────────────────────────

const { recordObservability, persistMemory } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 2 },
});

// ─── Signal Handler ────────────────────────────────────────────────────────

export const approvalSignal = defineSignal<[ApprovalDecision]>("approval");

// ─── HITL Approval Gate Workflow ───────────────────────────────────────────

export async function hitlApprovalGate(
  input: HITLApprovalInput
): Promise<HITLResult> {
  const timeoutMs = input.timeoutMs ?? 24 * 60 * 60 * 1000; // 24h default

  let decision: ApprovalDecision | null = null;
  let decisionReceived = false;

  // Register signal handler
  setHandler(approvalSignal, (dec: ApprovalDecision) => {
    decision = dec;
    decisionReceived = true;
  });

  // Emit approval request event
  await recordObservability({
    executionId: input.executionId,
    step: "hitl_approval_requested",
    status: "pending",
    attributes: {
      toolName: input.toolName,
      toolArgs: JSON.stringify(input.toolArgs),
      requesterNotes: input.requesterNotes ?? "",
      timeoutMs: String(timeoutMs),
    },
  });

  // Persist approval request
  try {
    await persistMemory({
      agentId: input.agentId,
      namespace: input.namespace,
      memoryType: "session",
      key: `approval_request_${input.executionId}`,
      data: {
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        requesterNotes: input.requesterNotes,
        requestedAt: new Date(0).toISOString(), // Deterministic placeholder
      },
    });
  } catch {
    // Non-fatal
  }

  // Wait for approval decision or timeout
  // Use condition() with timeout — fully deterministic, no Date.now()
  const timeoutSec = Math.floor(timeoutMs / 1000);
  const received = await condition(
    () => decisionReceived,
    `${timeoutSec}s`
  );

  if (!received) {
    // Timeout — auto-reject
    decision = { approver: "system", decision: "reject", reason: "Timeout" };
  }

  if (!decision) {
    throw new ApplicationFailure("No decision received");
  }

  // Record decision
  await recordObservability({
    executionId: input.executionId,
    step: `hitl_approval_${decision.decision}`,
    status: decision.decision === "approve" ? "approved" : "rejected",
    attributes: {
      approver: decision.approver,
      reason: decision.reason ?? "",
    },
  });

  // Persist decision
  try {
    await persistMemory({
      agentId: input.agentId,
      namespace: input.namespace,
      memoryType: "session",
      key: `approval_decision_${input.executionId}`,
      data: {
        decision: decision.decision,
        approver: decision.approver,
        reason: decision.reason,
      },
    });
  } catch {
    // Non-fatal
  }

  if (decision.decision === "reject") {
    throw new ApplicationFailure(
      `Human rejected execution: ${decision.reason ?? "No reason provided"}`
    );
  }

  return {
    decision: decision.decision,
    approver: decision.approver,
    reason: decision.reason,
  };
}
