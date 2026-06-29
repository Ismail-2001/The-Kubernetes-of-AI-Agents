import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/agent';

const MAX_REACT_ITERATIONS = 25;

const { 
  admitAgent, 
  createSandbox, 
  evaluatePolicy, 
  recordTrace,
  llmGenerate,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '1s', backoffCoefficient: 2 },
});

export async function agentExecutionWorkflow(params: {
  agentId: string;
  executionId: string;
  namespace: string;
  spec: any;
}): Promise<{ status: string; sandboxId: string; totalCost: string; steps: number; error?: string }> {
  const { agentId, executionId, spec } = params;

  await recordTrace({ executionId, step: 'admission', status: 'started' });

  const isAdmitted = await admitAgent({ agentId, spec });
  if (!isAdmitted) throw new Error('Agent failed admission policy.');

  const policyDecision = await evaluatePolicy({ agentId, action: 'start' });
  if (policyDecision.status !== 'allow') {
    throw new Error(`Policy Denied: ${policyDecision.reason}`);
  }

  const sandbox = await createSandbox({
    agentId,
    executionId,
    isolation: spec.runtime?.isolationLevel || 'Enhanced',
  });

  await recordTrace({ executionId, step: 'execution', status: 'running', sandboxId: sandbox.id });

  const systemPrompt = spec.systemPrompt || 'You are a helpful AI agent. Use the available tools to complete the user request.';
  const messages: any[] = [{ role: 'system', content: systemPrompt }, ...(spec.initialMessages || []) ];
  let totalCost = 0;
  let iteration = 0;

  while (iteration < MAX_REACT_ITERATIONS) {
    iteration++;

    await recordTrace({ executionId, step: `react-think-${iteration}`, status: 'running' });

    const result = await llmGenerate({
      agentId,
      executionId,
      messages,
    });

    const cost = parseFloat(result.cost?.replace('$', '') || '0');
    totalCost += cost;

    messages.push({ role: 'assistant', content: result.content });

    const lower = result.content.toLowerCase();

    if (lower.includes('[final answer]') || lower.includes('final answer:')) {
      await recordTrace({ executionId, step: `react-complete-${iteration}`, status: 'succeeded' });
      return {
        status: 'SUCCEEDED',
        sandboxId: sandbox.id,
        totalCost: `$${totalCost.toFixed(6)}`,
        steps: iteration,
      };
    }

    if (lower.includes('[tool:') || lower.includes('use tool:')) {
      const toolMatch = result.content.match(/\[tool:\s*(\w+)\]|"tool"\s*:\s*"(\w+)"/i);
      if (toolMatch) {
        messages.push({ role: 'user', content: `Tool ${toolMatch[1] || toolMatch[2]} executed successfully. Continue.` });
      } else {
        messages.push({ role: 'user', content: 'Action recorded. What is the result?' });
      }
    } else {
      messages.push({ role: 'user', content: 'Continue. If you have a final answer, prefix it with [FINAL ANSWER].' });
    }

    await sleep(100);
  }

  await recordTrace({ executionId, step: 'react-max-iterations', status: 'finished' });

  return {
    status: 'MAX_ITERATIONS_REACHED',
    sandboxId: sandbox.id,
    totalCost: `$${totalCost.toFixed(6)}`,
    steps: iteration,
    error: `ReAct loop exceeded ${MAX_REACT_ITERATIONS} iterations`,
  };
}
