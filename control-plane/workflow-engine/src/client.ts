import { Connection, Client } from '@temporalio/client';
import { agentExecutionWorkflow } from './workflows/agent';

export async function startAgentExecution(params: {
  agentId: string;
  executionId: string;
  namespace: string;
  spec: any;
}) {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_SERVER_ADDR || 'localhost:7233',
  });

  const client = new Client({
    connection,
    namespace: params.namespace || 'default',
  });

  const handle = await client.workflow.start(agentExecutionWorkflow, {
    args: [params],
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'egaop-agent-queue',
    workflowId: `egaop-${params.agentId}-${params.executionId}`,
    retry: { maximumAttempts: 3 },
  });

  return { workflowId: handle.workflowId };
}

export async function getAgentExecutionResult(workflowId: string) {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_SERVER_ADDR || 'localhost:7233',
  });

  const client = new Client({ connection, namespace: 'default' });
  const handle = client.workflow.getHandle(workflowId);
  return handle.result();
}
