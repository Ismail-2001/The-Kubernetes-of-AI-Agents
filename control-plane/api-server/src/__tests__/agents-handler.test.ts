import { agentHandlers } from "../agents/handler";

const mockRepo = {
  findByNamespaceAndName: jest.fn(),
  create: jest.fn(),
  listByNamespace: jest.fn(),
  update: jest.fn(),
  softDelete: jest.fn(),
};

jest.mock("../agents/repository", () => ({
  getAgentRepository: () => mockRepo,
}));

jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  return { ...actual, createAuditEntry: jest.fn() };
});

function callWith(metaNs: string | undefined, request: Record<string, unknown>) {
  return {
    request,
    metadata: {
      get: (k: string) => (k === "x-egaop-namespace" && metaNs !== undefined ? [metaNs] : []),
    },
  };
}

function invoke(handler: typeof agentHandlers.ListAgents, call: ReturnType<typeof callWith>): Promise<{ err: Error | null; res?: Record<string, unknown> }> {
  return new Promise((resolve) => {
    void handler(call as never, (err, res) => resolve({ err, res }));
  });
}

const row = (ns: string, name: string) => ({
  id: `uid-${name}`,
  namespace: ns,
  name,
  api_version: "egaop.io/v1",
  kind: "Agent",
  spec: {},
  status: { phase: "Running", health_status: "Healthy" },
  labels: {},
  annotations: {},
  version: 1,
  created_by: "tester",
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
});

beforeEach(() => jest.clearAllMocks());

describe("agents handler namespace scoping (x-egaop-namespace metadata authoritative)", () => {
  it("CreateAgent: rejects when body namespace differs from caller namespace", async () => {
    const { err } = await invoke(agentHandlers.CreateAgent, callWith("team-beta", { metadata: { name: "evil", namespace: "team-alpha" } }));
    expect(err).toBeTruthy();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it("CreateAgent: fails closed without namespace metadata", async () => {
    const { err } = await invoke(agentHandlers.CreateAgent, callWith(undefined, { metadata: { name: "a" } }));
    expect(err).toBeTruthy();
    expect((err as Error & { code: number }).code).toBe(3);
  });

  it("CreateAgent: creates in the caller namespace", async () => {
    mockRepo.findByNamespaceAndName.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue(row("team-beta", "agent-1"));
    const { err } = await invoke(agentHandlers.CreateAgent, callWith("team-beta", { metadata: { name: "agent-1", namespace: "team-beta" } }));
    expect(err).toBeNull();
    expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ namespace: "team-beta" }));
  });

  it("GetAgent: cross-namespace read is not-found, repo scoped to caller", async () => {
    const { err } = await invoke(agentHandlers.GetAgent, callWith("team-alpha", { name: "secret", namespace: "team-beta" }));
    expect(err).toBeTruthy();
    expect(mockRepo.findByNamespaceAndName).not.toHaveBeenCalled();
  });

  it("GetAgent: same-namespace read hits repo with caller namespace", async () => {
    mockRepo.findByNamespaceAndName.mockResolvedValue(row("team-alpha", "a1"));
    const { err, res } = await invoke(agentHandlers.GetAgent, callWith("team-alpha", { name: "a1", namespace: "team-alpha" }));
    expect(err).toBeNull();
    expect(res).toBeTruthy();
    expect(mockRepo.findByNamespaceAndName).toHaveBeenCalledWith("team-alpha", "a1");
  });

  it("ListAgents: cross-namespace list returns empty without repo access", async () => {
    const { err, res } = await invoke(agentHandlers.ListAgents, callWith("team-alpha", { namespace: "team-beta" }));
    expect(err).toBeNull();
    expect(res?.agents).toEqual([]);
    expect(mockRepo.listByNamespace).not.toHaveBeenCalled();
  });

  it("UpdateAgent: cross-namespace update is not-found, repo untouched", async () => {
    const { err } = await invoke(agentHandlers.UpdateAgent, callWith("team-alpha", { name: "victim", namespace: "team-beta", spec: { evil: true } }));
    expect(err).toBeTruthy();
    expect(mockRepo.update).not.toHaveBeenCalled();
  });

  it("DeleteAgent: cross-namespace delete is not-found, repo untouched", async () => {
    const { err } = await invoke(agentHandlers.DeleteAgent, callWith("team-alpha", { name: "victim", namespace: "team-beta" }));
    expect(err).toBeTruthy();
    expect(mockRepo.softDelete).not.toHaveBeenCalled();
  });

  it("DeleteAgent: same-namespace delete uses caller namespace", async () => {
    mockRepo.softDelete.mockResolvedValue(row("team-alpha", "a1"));
    const { err } = await invoke(agentHandlers.DeleteAgent, callWith("team-alpha", { name: "a1", namespace: "team-alpha" }));
    expect(err).toBeNull();
    expect(mockRepo.softDelete).toHaveBeenCalledWith("team-alpha", "a1");
  });
});
