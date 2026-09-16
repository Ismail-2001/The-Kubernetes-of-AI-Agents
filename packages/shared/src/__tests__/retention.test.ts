import {
  purgeAuditEntries,
  purgeExpiredRefreshTokens,
  anonymizeUser,
  purgeExpiredSpans,
  getRetentionStats,
  runRetentionCleanup,
  DEFAULT_RETENTION_CONFIG,
} from "../retention/index.js";

const mockQuery = jest.fn();
jest.mock("../db.js", () => ({
  getPool: jest.fn(() => Promise.resolve({ query: mockQuery })),
}));

beforeEach(() => {
  mockQuery.mockReset();
});

describe("purgeAuditEntries", () => {
  it("deletes audit entries older than maxAgeDays and returns count", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 });
    const count = await purgeAuditEntries(90);

    expect(count).toBe(5);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM audit_entries"),
      [90],
    );
  });

  it("returns 0 on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db error"));
    const count = await purgeAuditEntries(90);
    expect(count).toBe(0);
  });
});

describe("purgeExpiredRefreshTokens", () => {
  it("deletes expired tokens and returns count", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 12 });
    const count = await purgeExpiredRefreshTokens();

    expect(count).toBe(12);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM refresh_tokens"),
    );
  });

  it("returns 0 on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db error"));
    const count = await purgeExpiredRefreshTokens();
    expect(count).toBe(0);
  });
});

describe("anonymizeUser", () => {
  it("replaces PII with anonymized values and returns true", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const result = await anonymizeUser("user-123");

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE users"),
      expect.arrayContaining([
        expect.stringMatching(/^anonymized-[a-f0-9]{12}@deleted\.local$/),
        "user-123",
      ]),
    );
  });

  it("returns false when user not found", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const result = await anonymizeUser("nonexistent");
    expect(result).toBe(false);
  });

  it("returns false on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db error"));
    const result = await anonymizeUser("user-123");
    expect(result).toBe(false);
  });
});

describe("purgeExpiredSpans", () => {
  it("deletes spans older than maxAgeDays and returns count", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 30 });
    const count = await purgeExpiredSpans(30);

    expect(count).toBe(30);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM spans"),
      [30],
    );
  });

  it("returns 0 on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db error"));
    const count = await purgeExpiredSpans(30);
    expect(count).toBe(0);
  });
});

describe("getRetentionStats", () => {
  it("returns counts for each table", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 100 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ count: 200 }] });

    const stats = await getRetentionStats();

    expect(stats).toEqual({
      auditEntriesEligible: 100,
      expiredRefreshTokens: 5,
      spansEligible: 200,
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("returns zeros on query failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db error"));
    const stats = await getRetentionStats();

    expect(stats).toEqual({
      auditEntriesEligible: 0,
      expiredRefreshTokens: 0,
      spansEligible: 0,
    });
  });
});

describe("runRetentionCleanup", () => {
  it("calls all purge functions and returns summary", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 10 })  // audit
      .mockResolvedValueOnce({ rowCount: 3 })   // tokens
      .mockResolvedValueOnce({ rowCount: 25 }); // spans

    const summary = await runRetentionCleanup();

    expect(summary.auditEntriesDeleted).toBe(10);
    expect(summary.refreshTokensDeleted).toBe(3);
    expect(summary.spansDeleted).toBe(25);
    expect(summary.totalDeleted).toBe(38);
    expect(summary.timestamp).toBeDefined();
  });

  it("uses default config when none provided", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await runRetentionCleanup();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM audit_entries"),
      [DEFAULT_RETENTION_CONFIG.auditLogDays],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM spans"),
      [DEFAULT_RETENTION_CONFIG.spanDays],
    );
  });

  it("accepts custom config", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await runRetentionCleanup({ auditLogDays: 60, refreshTokenDays: 7, spanDays: 14 });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM audit_entries"),
      [60],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM spans"),
      [14],
    );
  });

  it("handles partial failures gracefully", async () => {
    mockQuery
      .mockRejectedValueOnce(new Error("audit db error"))
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const summary = await runRetentionCleanup();

    expect(summary.auditEntriesDeleted).toBe(0);
    expect(summary.refreshTokensDeleted).toBe(2);
    expect(summary.spansDeleted).toBe(0);
    expect(summary.totalDeleted).toBe(2);
  });
});
