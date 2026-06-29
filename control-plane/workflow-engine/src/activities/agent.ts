import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import fs from 'fs';
import path from 'path';

const TLS_ENABLED = process.env.TLS_ENABLED === 'true';
const TLS_CERT_DIR = process.env.TLS_CERT_DIR || '/etc/egaop/certs';

function getClientCredentials(): grpc.ChannelCredentials {
  if (!TLS_ENABLED) return grpc.credentials.createInsecure();
  return grpc.credentials.createSsl(
    fs.readFileSync(path.join(TLS_CERT_DIR, 'ca-cert.pem')),
    fs.readFileSync(path.join(TLS_CERT_DIR, 'client-cert.pem')),
    fs.readFileSync(path.join(TLS_CERT_DIR, 'client-key.pem'))
  );
}

const PROTO_ROOT = path.resolve(__dirname, '../../../../api/proto');

function loadService(protoFile: string, serviceName: string) {
  const def = protoLoader.loadSync(protoFile, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const parts = serviceName.split('.');
  let svc = pkg;
  for (const part of parts) svc = svc[part];
  return svc;
}

function createClient(serviceProto: string, serviceName: string, address: string) {
  const svc = loadService(
    path.resolve(PROTO_ROOT, serviceProto),
    serviceName
  );
  return new svc(address, getClientCredentials());
}

function promisify<TReq, TRes>(client: any, method: string): (args: TReq) => Promise<TRes> {
  return (args: TReq) =>
    new Promise<TRes>((resolve, reject) => {
      const deadline = new Date();
      deadline.setSeconds(deadline.getSeconds() + 10);
      client[method](args, { deadline }, (err: any, res: TRes) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
}

const apiServerAddr = process.env.API_SERVER_ADDR || 'localhost:50051';
const sandboxAddr = process.env.SANDBOX_RUNTIME_ADDR || 'localhost:50054';
const observabilityAddr = process.env.OBSERVABILITY_PLANE_ADDR || 'localhost:50056';
const llmRouterAddr = process.env.LLM_ROUTER_ADDR || 'localhost:50053';

const agentClient = createClient('egaop/v1/agent.proto', 'egaop.v1.AgentService', apiServerAddr);
const runtimeClient = createClient('egaop/v1/runtime.proto', 'egaop.v1.RuntimeService', sandboxAddr);
const obsClient = createClient('egaop/v1/execution.proto', 'egaop.v1.ObservabilityService', observabilityAddr);
const llmClient = createClient('egaop/v1/llm.proto', 'egaop.v1.LLMService', llmRouterAddr);

const admitAgentCall = promisify<any, any>(agentClient, 'CreateAgent');
const createSandboxCall = promisify<any, any>(runtimeClient, 'CreateSandbox');
const recordTraceCall = promisify<any, any>(obsClient, 'ExportTrace');
const llmGenerateCall = promisify<any, any>(llmClient, 'Generate');

export async function admitAgent(params: { agentId: string; spec: any }): Promise<boolean> {
  try {
    const response = await admitAgentCall({
      metadata: { name: params.agentId, namespace: 'default' },
      spec: params.spec,
    });
    return response?.status?.phase === 'Pending' || response?.status?.phase === 'Running';
  } catch (err: any) {
    throw new Error(`Admission failed: ${err.details || err.message}`);
  }
}

export async function createSandbox(params: { agentId: string; executionId: string; isolation: string }) {
  try {
    const response = await createSandboxCall({
      agent_id: params.agentId,
      execution_id: params.executionId,
      isolation_level: params.isolation,
      resources: {},
      env_vars: { EGAOP_AGENT_ID: params.agentId, EGAOP_EXECUTION_ID: params.executionId },
    });
    return { id: response.sandbox_id, status: response.status };
  } catch (err: any) {
    throw new Error(`Sandbox creation failed: ${err.details || err.message}`);
  }
}

export async function evaluatePolicy(params: { agentId: string; action: string }) {
  return { status: 'allow' as const, reason: '' };
}

export async function recordTrace(params: { executionId: string; step: string; status: string; sandboxId?: string }) {
  try {
    await recordTraceCall({
      execution_id: params.executionId,
      span_id: `span-${params.step}-${Date.now()}`,
      name: params.step,
      start_time: { seconds: Math.floor(Date.now() / 1000) },
      end_time: { seconds: Math.floor(Date.now() / 1000) },
      attributes: { fields: { 'egaop.step.status': { stringValue: params.status } } },
    });
    return { success: true };
  } catch {
    return { success: false };
  }
}

export async function llmGenerate(params: { agentId: string; executionId: string; messages: any[] }) {
  try {
    const response = await llmGenerateCall({
      agent_id: params.agentId,
      execution_id: params.executionId,
      messages: params.messages,
      temperature: 0.7,
    });
    return {
      content: response.content,
      model_used: response.model_used,
      usage: response.usage,
      cost: response.cost,
    };
  } catch (err: any) {
    throw new Error(`LLM generation failed: ${err.details || err.message}`);
  }
}
