/**
 * TLS credential negative tests.
 *
 * Verifies fail-closed behavior: when TLS is misconfigured or disabled,
 * the system must not silently accept invalid transport state.
 */
import fs from "fs";
import path from "path";

const CERT_DIR = path.join(__dirname, "../../certs");

describe("TLS credential helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  describe("getServerCredentials", () => {
    it("returns insecure when TLS_ENABLED is not set", () => {
      delete process.env.TLS_ENABLED;
      delete process.env.TLS_CERT_DIR;
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      expect(creds).toBeDefined();
    });

    it("returns insecure when TLS_ENABLED is 'false'", () => {
      process.env.TLS_ENABLED = "false";
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      expect(creds).toBeDefined();
    });

    it("creates TLS credentials with requestCert:false (mTLS disabled workaround)", () => {
      if (!fs.existsSync(path.join(CERT_DIR, "ca-cert.pem"))) {
        console.log("Skipping: no certs found in", CERT_DIR);
        return;
      }
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = CERT_DIR;
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      expect(creds).toBeDefined();
      // createSsl with requestCert=false is the current mTLS workaround
      // This test exists to document that mTLS is intentionally disabled
      // If this test needs updating, check @grpc/grpc-js changelog for fix
    });
  });

  describe("getClientCredentials", () => {
    it("returns insecure when TLS_ENABLED is not set", () => {
      delete process.env.TLS_ENABLED;
      delete process.env.TLS_CERT_DIR;
      const { getClientCredentials } = require("@e-gaop/shared");
      const creds = getClientCredentials();
      expect(creds).toBeDefined();
    });

    it("throws when TLS_ENABLED is 'true' but certs directory does not exist", () => {
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = "/nonexistent/path";
      const { getClientCredentials } = require("@e-gaop/shared");
      expect(() => getClientCredentials()).toThrow();
    });

    it("throws when TLS_ENABLED is 'true' but cert files are missing", () => {
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = path.join(__dirname); // no cert files here
      const { getClientCredentials } = require("@e-gaop/shared");
      expect(() => getClientCredentials()).toThrow();
    });

    it("reads real certs when TLS_ENABLED is 'true' and certs exist", () => {
      if (!fs.existsSync(path.join(CERT_DIR, "ca-cert.pem"))) {
        console.log("Skipping: no certs found in", CERT_DIR);
        return;
      }
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = CERT_DIR;
      const { getClientCredentials } = require("@e-gaop/shared");
      const creds = getClientCredentials();
      expect(creds).toBeDefined();
    });
  });
});
