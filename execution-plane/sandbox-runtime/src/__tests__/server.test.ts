import http from "http";
import path from "path";
import { spawn, ChildProcess } from "child_process";

describe("Sandbox base-runtime server.js", () => {
  const SERVER_PATH = path.resolve(__dirname, "../../base-runtime/server.js");
  const TEST_PORT = 18080;
  const TEST_TOKEN = "test-secret-token-1234567890abcdef1234567890abcdef";

  function makeRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: TEST_PORT,
          path: urlPath,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode || 500, body: data ? JSON.parse(data) : {} });
            } catch {
              resolve({ status: res.statusCode || 500, body: { raw: data } as Record<string, unknown> });
            }
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  describe("Startup validation", () => {
    it("exits with non-zero exit code if SANDBOX_EXEC_TOKEN is unset", async () => {
      const proc = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(TEST_PORT), SANDBOX_EXEC_TOKEN: "" },
        stdio: "ignore",
      });
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      expect(exitCode).toBe(1);
    });
  });

  describe("Running server behavior", () => {
    let serverProc: ChildProcess;

    beforeAll(async () => {
      serverProc = spawn(process.execPath, [SERVER_PATH], {
        env: {
          ...process.env,
          PORT: String(TEST_PORT),
          SANDBOX_EXEC_TOKEN: TEST_TOKEN,
        },
        stdio: "ignore",
      });

      // Wait for server to start listening
      for (let i = 0; i < 40; i++) {
        try {
          const res = await makeRequest("GET", "/healthz", {});
          if (res.status === 200) break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    });

    afterAll(async () => {
      if (serverProc) {
        serverProc.kill();
        await new Promise((resolve) => {
          serverProc.on("close", resolve);
          setTimeout(resolve, 1000);
        });
      }
    });

    it("/healthz returns 200 and does NOT include pid", async () => {
      const res = await makeRequest("GET", "/healthz", {});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.pid).toBeUndefined();
    });

    it("rejects /exec with 401 when Authorization header is missing", async () => {
      const res = await makeRequest("POST", "/exec", {}, {
        tool: "file_read",
        args: { path: "/etc/hosts" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects /exec with 401 when Authorization token is invalid", async () => {
      const res = await makeRequest(
        "POST",
        "/exec",
        { Authorization: "Bearer wrong-token" },
        { tool: "file_read", args: { path: "/etc/hosts" } }
      );
      expect(res.status).toBe(401);
    });

    it("allows /exec with 200 when Authorization token is correct", async () => {
      const res = await makeRequest(
        "POST",
        "/exec",
        { Authorization: `Bearer ${TEST_TOKEN}` },
        { tool: "file_read", args: { path: "/etc/hosts" } }
      );
      expect(res.status).toBe(200);
    });

    it("rejects legacy raw command payloads with 400", async () => {
      const res = await makeRequest(
        "POST",
        "/exec",
        { Authorization: `Bearer ${TEST_TOKEN}` },
        { command: "echo hello" }
      );
      expect(res.status).toBe(400);
    });
  });
});
