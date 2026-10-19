const mockContainer = {
  id: "abc123def456",
  start: jest.fn(),
  stop: jest.fn(),
  remove: jest.fn(),
  inspect: jest.fn(),
  wait: jest.fn(),
  exec: jest.fn(),
};

const mockDocker = {
  createContainer: jest.fn(),
  getContainer: jest.fn(),
  listContainers: jest.fn(),
  ping: jest.fn(),
};

jest.mock("dockerode", () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

import { DockerSandboxDriver } from "../docker-driver";

const mockStream = () => ({
  on: jest.fn((event: string, cb: any) => {
    if (event === "data") cb(Buffer.from("init-output"));
    if (event === "end") cb();
  }),
});

const BASE_SPEC = {
  executionId: "exec-1",
  agentId: "agent-1",
  namespace: "egaop",
  image: "egaop-base-runtime:latest",
  isolationLevel: "Standard" as const,
  cpu: "0.5",
  memory: "256",
  envVars: { FOO: "bar" },
};

describe("DockerSandboxDriver", () => {
  let driver: DockerSandboxDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SANDBOX_MAX_CONTAINERS;
    delete process.env.SANDBOX_SECCOMP_PROFILE;
    mockContainer.start.mockResolvedValue(undefined);
    mockContainer.remove.mockResolvedValue(undefined);
    mockContainer.inspect.mockResolvedValue({
      State: { Status: "running", Running: true, StartedAt: "2025-01-01T00:00:00Z" },
      HostConfig: { NanoCpus: 1000000000 },
      NetworkSettings: { Networks: { "egaop-sandbox": { IPAddress: "10.0.0.42" } } },
    });
    mockContainer.exec.mockResolvedValue({
      start: jest.fn().mockResolvedValue(mockStream()),
    });
    mockDocker.createContainer.mockResolvedValue(mockContainer);
    mockDocker.getContainer.mockReturnValue(mockContainer);
    mockDocker.ping.mockResolvedValue("PONG");
    driver = new DockerSandboxDriver(mockDocker as any);
  });

  describe("createSandbox", () => {
    it("should create container with correct settings", async () => {
      const result = await driver.createSandbox({
        executionId: "exec-1",
        agentId: "agent-1",
        namespace: "egaop",
        image: "egaop-base-runtime:latest",
        isolationLevel: "Standard",
        cpu: "0.5",
        memory: "256",
        envVars: { FOO: "bar" },
      });

      expect(result.sandboxId).toBe("abc123def456");
      expect(result.status).toBe("Running");
      expect(result.ipAddress).toBe("10.0.0.42");

      expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.NanoCpus).toBe(500_000_000);
      expect(opts.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(opts.Env).toContain("FOO=bar");
    });

    it("should use a read-only rootfs with tmpfs scratch + workspace (P1-5)", async () => {
      await driver.createSandbox({
        executionId: "exec-ro",
        agentId: "agent-1",
        namespace: "egaop",
        image: "egaop-base-runtime:latest",
        isolationLevel: "Standard",
      });

      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.ReadonlyRootfs).toBe(true);
      expect(opts.HostConfig.Tmpfs["/tmp"]).toMatch(/noexec/);
      expect(opts.HostConfig.Tmpfs["/tmp"]).toMatch(/nosuid/);
      expect(opts.HostConfig.Tmpfs["/tmp"]).toMatch(/mode=1777/);
      expect(opts.HostConfig.Tmpfs["/workspace"]).toMatch(/nosuid/);
      expect(opts.HostConfig.Tmpfs["/workspace"]).toMatch(/mode=1777/);
      expect(opts.Cmd).toEqual(["node", "/opt/egaop/server.js"]);
    });

    it("should set gVisor runtime for Enhanced isolation", async () => {
      await driver.createSandbox({
        executionId: "exec-2",
        agentId: "agent-2",
        namespace: "egaop",
        image: "egaop-base-runtime:latest",
        isolationLevel: "Enhanced",
      });

      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.Runtime).toBe("runsc");
    });

    it("should set firecracker runtime for Maximum isolation", async () => {
      await driver.createSandbox({
        executionId: "exec-3",
        agentId: "agent-3",
        namespace: "egaop",
        image: "egaop-base-runtime:latest",
        isolationLevel: "Maximum",
      });

      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.Runtime).toBe("firecracker");
    });

    it("should reject disallowed images", async () => {
      await expect(driver.createSandbox({
        executionId: "exec-3",
        agentId: "agent-3",
        namespace: "egaop",
        image: "ubuntu:latest",
      })).rejects.toThrow("Image not in allowlist");
    });

    it("should apply defaults when cpu, memory and image are not provided", async () => {
      await driver.createSandbox({
        executionId: "exec-4",
        agentId: "agent-4",
        namespace: "egaop",
        image: "",
      });

      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.NanoCpus).toBe(500_000_000);
      expect(opts.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(opts.Image).toBe("egaop-base-runtime:latest");
      expect(opts.Env).toEqual([]);
    });

    it("should keep ipAddress unknown when the sandbox network is absent", async () => {
      mockContainer.inspect.mockResolvedValueOnce({
        State: { Status: "running", Running: true },
        NetworkSettings: { Networks: {} },
      });

      const result = await driver.createSandbox(BASE_SPEC);
      expect(result.ipAddress).toBe("unknown");
    });

    it("should add the seccomp profile to security options when configured", async () => {
      process.env.SANDBOX_SECCOMP_PROFILE = "/run/seccomp/custom.json";
      driver = new DockerSandboxDriver(mockDocker as any);

      await driver.createSandbox(BASE_SPEC);
      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.SecurityOpt).toContain("seccomp=/run/seccomp/custom.json");
    });

    it("should not add seccomp options when the profile is blank", async () => {
      process.env.SANDBOX_SECCOMP_PROFILE = "   ";
      driver = new DockerSandboxDriver(mockDocker as any);

      await driver.createSandbox(BASE_SPEC);
      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    });

    it("should remove the container and release the slot when start fails", async () => {
      mockContainer.start.mockRejectedValueOnce(new Error("start failed"));

      await expect(driver.createSandbox(BASE_SPEC)).rejects.toThrow("start failed");
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("should propagate createContainer errors and release the slot", async () => {
      mockDocker.createContainer.mockRejectedValueOnce(new Error("docker down"));

      await expect(driver.createSandbox(BASE_SPEC)).rejects.toThrow("docker down");
    });
  });

  describe("init commands", () => {
    it("should run allowed commands and collect their output", async () => {
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: ["echo hello"] });
      expect(result.initOutputs).toEqual(["init-output"]);
    });

    it("should block forbidden binaries", async () => {
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: ["rm -rf /tmp"] });
      expect(result.initOutputs).toEqual(["BLOCKED: command rejected by security policy"]);
      expect(mockContainer.exec).not.toHaveBeenCalled();
    });

    it("should block shell metacharacters", async () => {
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: ["echo a; cat /etc/passwd"] });
      expect(result.initOutputs).toEqual(["BLOCKED: command rejected by security policy"]);
    });

    it("should block empty commands", async () => {
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: [""] });
      expect(result.initOutputs).toEqual(["BLOCKED: command rejected by security policy"]);
    });

    it("should block commands longer than 4096 characters", async () => {
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: ["a".repeat(4097)] });
      expect(result.initOutputs).toEqual(["BLOCKED: command rejected by security policy"]);
    });

    it("should block commands with too many tokens", async () => {
      const cmd = Array.from({ length: 129 }, () => "a").join(" ");
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: [cmd] });
      expect(result.initOutputs).toEqual(["BLOCKED: command rejected by security policy"]);
    });

    it("should block commands whose binary is not in the allowlist", async () => {
      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: [".hidden"] });
      expect(result.initOutputs).toEqual(["BLOCKED: command rejected by security policy"]);
    });

    it("should capture errors from failing exec calls", async () => {
      mockContainer.exec.mockRejectedValueOnce(new Error("exec failed"));

      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: ["echo hello"] });
      expect(result.initOutputs).toEqual(["ERROR: exec failed"]);
    });

    it("should stringify non-Error failures from exec calls", async () => {
      mockContainer.exec.mockRejectedValueOnce("exec failed");

      const result = await driver.createSandbox({ ...BASE_SPEC, initCommands: ["echo hello"] });
      expect(result.initOutputs).toEqual(["ERROR: exec failed"]);
    });
  });

  describe("terminateSandbox", () => {
    it("should remove container with force", async () => {
      const result = await driver.terminateSandbox("abc123def456");
      expect(result).toBe(true);
      expect(mockDocker.getContainer).toHaveBeenCalledWith("abc123def456");
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("should return false on error", async () => {
      mockContainer.remove.mockRejectedValueOnce(new Error("not found"));
      const result = await driver.terminateSandbox("abc123def456");
      expect(result).toBe(false);
    });
  });

  describe("getSandboxStatus", () => {
    it("should return status from inspect", async () => {
      const status = await driver.getSandboxStatus("abc123def456");
      expect(status.status).toBe("running");
      expect(status.startedAt).toEqual(new Date("2025-01-01T00:00:00Z"));
    });

    it("should return NotFound for a missing container", async () => {
      mockContainer.inspect.mockRejectedValueOnce({ statusCode: 404 });
      const status = await driver.getSandboxStatus("missing");
      expect(status.status).toBe("NotFound");
    });

    it("should return Unknown on other errors", async () => {
      mockContainer.inspect.mockRejectedValueOnce(new Error("boom"));
      const status = await driver.getSandboxStatus("broken");
      expect(status.status).toBe("Unknown");
    });

    it("should default status and startedAt when not reported", async () => {
      mockContainer.inspect.mockResolvedValueOnce({ State: {} });
      const status = await driver.getSandboxStatus("abc123def456");
      expect(status.status).toBe("unknown");
      expect(status.startedAt).toBeNull();
    });
  });

  describe("container limit", () => {
    it("should reject a request that waits too long for a slot", async () => {
      process.env.SANDBOX_MAX_CONTAINERS = "1";
      driver = new DockerSandboxDriver(mockDocker as any);
      let releaseHolding: (value: typeof mockContainer) => void = () => {};
      mockDocker.createContainer.mockImplementation(() => new Promise((resolve) => { releaseHolding = resolve; }));

      jest.useFakeTimers();
      const holding = driver.createSandbox(BASE_SPEC);
      const waiting = driver.createSandbox(BASE_SPEC);
      jest.advanceTimersByTime(5000);
      await expect(waiting).rejects.toThrow("container limit");
      jest.useRealTimers();
      releaseHolding(mockContainer);
      await holding;
    });

    it("should grant a slot to a queued request when one is released", async () => {
      process.env.SANDBOX_MAX_CONTAINERS = "1";
      driver = new DockerSandboxDriver(mockDocker as any);

      const first = await driver.createSandbox(BASE_SPEC);
      const queued = driver.createSandbox({ ...BASE_SPEC, executionId: "exec-2" });
      await driver.terminateSandbox(first.sandboxId);
      await queued;

      expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
    });
  });

  describe("cleanup", () => {
    it("should remove all active containers", async () => {
      await driver.createSandbox(BASE_SPEC);
      expect(driver.activeContainerCount).toBe(1);

      await driver.cleanup();
      expect(driver.activeContainerCount).toBe(0);
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("should be a no-op when there are no active containers", async () => {
      await driver.cleanup();
      expect(driver.activeContainerCount).toBe(0);
      expect(mockContainer.remove).not.toHaveBeenCalled();
    });

    it("should tolerate failures while removing containers", async () => {
      await driver.createSandbox(BASE_SPEC);
      mockContainer.remove.mockRejectedValueOnce(new Error("remove failed"));

      await driver.cleanup();
      expect(driver.activeContainerCount).toBe(0);
    });
  });

  describe("health", () => {
    it("should return true when Docker responds", async () => {
      const ok = await driver.health();
      expect(ok).toBe(true);
    });

    it("should return false when Docker fails", async () => {
      mockDocker.ping.mockRejectedValueOnce(new Error("timeout"));
      const ok = await driver.health();
      expect(ok).toBe(false);
    });
  });
});
