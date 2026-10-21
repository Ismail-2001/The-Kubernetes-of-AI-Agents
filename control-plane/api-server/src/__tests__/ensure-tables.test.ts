const mockQuery = jest.fn();
const mockPool = { query: mockQuery };

jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  return { ...actual, getPool: jest.fn() };
});

import { getPool } from "@e-gaop/shared";
import { ensureAuthTables, ensureTables } from "../ensure-tables";

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  (getPool as jest.Mock).mockReset();
  (getPool as jest.Mock).mockResolvedValue(mockPool);
});

describe("ensure-tables", () => {
  it("creates the auth tables and email index", async () => {
    await ensureAuthTables();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_users_email");
  });

  it("creates notification, policy, and analytics tables", async () => {
    await ensureTables();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notification_channels");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notification_rules");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS webhook_deliveries");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS policies");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS llm_usage");
    expect(sql).toContain("idx_webhook_deliveries_status");
  });
});
