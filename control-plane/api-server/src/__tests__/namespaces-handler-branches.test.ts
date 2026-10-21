const mockCreate = jest.fn();
const mockFindBySlug = jest.fn();
const mockList = jest.fn();
const mockUpdate = jest.fn();
const mockSuspend = jest.fn();
const mockSoftDelete = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock("../namespaces/repository.js", () => ({
  NamespaceRepository: jest.fn(() => ({
    create: mockCreate,
    findBySlug: mockFindBySlug,
    list: mockList,
    update: mockUpdate,
    suspend: mockSuspend,
    softDelete: mockSoftDelete,
  })),
}));

jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  return {
    ...actual,
    getPool: jest.fn(() => ({ query: mockPoolQuery })),
  };
});

import { namespaceHandlers } from "../namespaces/handler.js";

type Handler = (
  call: { request: Record<string, unknown> },
  callback: (err: Error | null, response?: Record<string, unknown>) => void,
) => Promise<void>;

const handlers = namespaceHandlers as unknown as Record<string, Handler>;

function makeNamespace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ns-1",
    slug: "team-a",
    displayName: "Team A",
    tier: "standard",
    ownerId: "u-1",
    quotas: {
      maxAgents: 10,
      maxConcurrentExecutions: 5,
      maxMemoryMB: 512,
      maxToolCallsPerMinute: 60,
    },
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    suspendedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockFindBySlug.mockReset();
  mockList.mockReset();
  mockUpdate.mockReset();
  mockSuspend.mockReset();
  mockSoftDelete.mockReset();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

describe("namespace handler branch coverage", () => {
  it("falls back to sandbox tier for unknown tier strings", async () => {
    mockCreate.mockResolvedValue(makeNamespace({ tier: "sandbox" }));

    await handlers["CreateNamespace"]!(
      { request: { slug: "team-a", tier: "NOT_A_REAL_TIER" } },
      jest.fn(),
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "team-a", tier: "sandbox" }),
    );
  });

  it.each([
    ["GetNamespace", mockFindBySlug, "Failed to get namespace"],
    ["ListNamespaces", mockList, "Failed to list namespaces"],
    ["UpdateNamespace", mockUpdate, "Failed to update namespace"],
    ["SuspendNamespace", mockSuspend, "Failed to suspend namespace"],
    ["DeleteNamespace", mockSoftDelete, "Failed to delete namespace"],
  ] as [string, jest.Mock, string][])(
    "%s stringifies non-Error rejections",
    async (name, repoFn, prefix) => {
      repoFn.mockRejectedValue("raw-rejection");

      const callback = jest.fn();
      await handlers[name]!({ request: { slug: "team-a" } }, callback);

      expect(callback).toHaveBeenCalledWith(new Error(`${prefix}: raw-rejection`));
    },
  );

  it("loads logger configuration for non-test environments", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevLogLevel = process.env.LOG_LEVEL;
    try {
      process.env.NODE_ENV = "development";
      delete process.env.LOG_LEVEL;
      jest.isolateModules(() => {
        require("../namespaces/handler.js");
      });
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prevLogLevel;
    }
  });
});
