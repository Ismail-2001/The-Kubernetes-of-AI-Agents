import { getSecret, loadSecretsIntoEnv } from "../config/secrets.js";
import fs from "fs";
import path from "path";

jest.mock("fs");

const mockFs = jest.mocked(fs);

describe("getSecret", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockFs.readFileSync.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should read from Docker secrets file first", () => {
    mockFs.readFileSync.mockReturnValue("  secret-value  ");
    const value = getSecret("JWT_SECRET");
    expect(value).toBe("secret-value");
    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining("jwt_secret"),
      "utf-8"
    );
  });

  it("should fall back to environment variable", () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.MY_SECRET = "env-value";
    const value = getSecret("MY_SECRET");
    expect(value).toBe("env-value");
  });

  it("should return undefined if neither source has value", () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    delete process.env.MISSING_SECRET;
    const value = getSecret("MISSING_SECRET");
    expect(value).toBeUndefined();
  });

  it("should return undefined for empty secret file", () => {
    mockFs.readFileSync.mockReturnValue("   ");
    const value = getSecret("JWT_SECRET");
    expect(value).toBeUndefined();
  });

  it("should prefer file over env var", () => {
    mockFs.readFileSync.mockReturnValue("file-value");
    process.env.JWT_SECRET = "env-value";
    const value = getSecret("JWT_SECRET");
    expect(value).toBe("file-value");
  });
});

describe("loadSecretsIntoEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockFs.readFileSync.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should populate env vars from Docker secrets", () => {
    mockFs.readFileSync.mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes("jwt_secret")) return "jwt-from-file";
      if (p.includes("postgres_password")) return "pg-from-file";
      throw new Error("ENOENT");
    });

    delete process.env.JWT_SECRET;
    delete process.env.POSTGRES_PASSWORD;

    loadSecretsIntoEnv();

    expect(process.env.JWT_SECRET).toBe("jwt-from-file");
    expect(process.env.POSTGRES_PASSWORD).toBe("pg-from-file");
  });

  it("should not override existing env vars", () => {
    mockFs.readFileSync.mockReturnValue("file-value");
    process.env.JWT_SECRET = "existing-value";

    loadSecretsIntoEnv();

    expect(process.env.JWT_SECRET).toBe("existing-value");
  });
});
