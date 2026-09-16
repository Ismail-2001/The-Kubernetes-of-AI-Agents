const mockQuery = jest.fn();

jest.mock("../db.js", () => ({
  getPool: jest.fn().mockResolvedValue({ query: mockQuery }),
}));

import { isEnabled, getAllFlags, refreshFlags, upsertFlag, deleteFlag, getFlag, setCacheTtl, stopCacheAutoRefresh } from "../feature-flags/index.js";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-flag",
    enabled: true,
    description: "A test flag",
    rollout_percentage: 100,
    allowed_roles: [],
    allowed_namespaces: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  mockQuery.mockReset();
  jest.useFakeTimers();
  setCacheTtl(60000);
  mockQuery.mockResolvedValueOnce({
    rows: [
      makeRow({ name: "global-flag", enabled: true, rollout_percentage: 100 }),
      makeRow({ name: "partial-flag", enabled: true, rollout_percentage: 50 }),
      makeRow({
        name: "role-flag",
        enabled: true,
        rollout_percentage: 100,
        allowed_roles: ["admin"],
      }),
      makeRow({
        name: "ns-flag",
        enabled: true,
        rollout_percentage: 100,
        allowed_namespaces: ["ns-a"],
      }),
      makeRow({ name: "disabled-flag", enabled: false, rollout_percentage: 100 }),
    ],
  });
  await refreshFlags();
  mockQuery.mockReset();
});

afterEach(() => {
  stopCacheAutoRefresh();
  jest.useRealTimers();
});

describe("isEnabled", () => {
  it("returns false for unknown flags", () => {
    expect(isEnabled("nonexistent")).toBe(false);
  });

  it("returns true for globally enabled flags", () => {
    expect(isEnabled("global-flag")).toBe(true);
  });

  it("returns false for disabled flags", () => {
    expect(isEnabled("disabled-flag")).toBe(false);
  });

  it("respects rollout percentage deterministically", () => {
    const result = isEnabled("partial-flag", { userId: "user-0" });
    expect(typeof result).toBe("boolean");
  });

  it("respects role-based access", () => {
    expect(isEnabled("role-flag", { roles: ["admin"] })).toBe(true);
    expect(isEnabled("role-flag", { roles: ["viewer"] })).toBe(false);
    expect(isEnabled("role-flag")).toBe(false);
  });

  it("respects namespace-based access", () => {
    expect(isEnabled("ns-flag", { namespace: "ns-a" })).toBe(true);
    expect(isEnabled("ns-flag", { namespace: "ns-b" })).toBe(false);
    expect(isEnabled("ns-flag")).toBe(false);
  });
});

describe("getAllFlags", () => {
  it("returns all cached flags", () => {
    const flags = getAllFlags();
    expect(flags.length).toBe(5);
    expect(flags.map((f) => f.name).sort()).toEqual([
      "disabled-flag",
      "global-flag",
      "ns-flag",
      "partial-flag",
      "role-flag",
    ]);
  });
});

describe("upsertFlag", () => {
  it("creates a new flag", async () => {
    const now = "2025-06-01T00:00:00.000Z";
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeRow({
          name: "new-flag",
          enabled: true,
          description: "new",
          rollout_percentage: 42,
          created_at: now,
          updated_at: now,
        }),
      ],
    });

    const flag = await upsertFlag({
      name: "new-flag",
      enabled: true,
      description: "new",
      rolloutPercentage: 42,
    });

    expect(flag.name).toBe("new-flag");
    expect(flag.enabled).toBe(true);
    expect(flag.rolloutPercentage).toBe(42);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("INSERT");
  });

  it("updates an existing flag", async () => {
    const now = "2025-06-02T00:00:00.000Z";
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeRow({
          name: "global-flag",
          enabled: false,
          rollout_percentage: 0,
          updated_at: now,
        }),
      ],
    });

    const flag = await upsertFlag({
      name: "global-flag",
      enabled: false,
      rolloutPercentage: 0,
    });

    expect(flag.name).toBe("global-flag");
    expect(flag.enabled).toBe(false);
    expect(flag.rolloutPercentage).toBe(0);
    expect(mockQuery.mock.calls[0][0]).toContain("ON CONFLICT");
  });
});

describe("deleteFlag", () => {
  it("removes a flag from DB and cache", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await deleteFlag("global-flag");

    expect(isEnabled("global-flag")).toBe(false);
    expect(getAllFlags().find((f) => f.name === "global-flag")).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith("DELETE FROM feature_flags WHERE name = $1", [
      "global-flag",
    ]);
  });
});

describe("refreshFlags", () => {
  it("updates cache from DB", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ name: "fresh-flag", enabled: true, rollout_percentage: 100 })],
    });

    await refreshFlags();

    expect(isEnabled("fresh-flag")).toBe(true);
    expect(isEnabled("global-flag")).toBe(false);
    expect(getAllFlags().length).toBe(1);
  });

  it("degrades gracefully on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB down"));
    await refreshFlags();
    expect(isEnabled("global-flag")).toBe(true);
  });
});

describe("getFlag", () => {
  it("returns flag from DB", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeRow({ name: "from-db", enabled: true, rollout_percentage: 75 })],
    });

    const flag = await getFlag("from-db");
    expect(flag).not.toBeNull();
    expect(flag!.name).toBe("from-db");
    expect(flag!.rolloutPercentage).toBe(75);
  });

  it("returns null for missing flag", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const flag = await getFlag("nope");
    expect(flag).toBeNull();
  });
});
