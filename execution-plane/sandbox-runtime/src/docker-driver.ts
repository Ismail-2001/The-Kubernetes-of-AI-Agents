import Docker from "dockerode";
import type { SandboxDriver, SandboxSpec, SandboxResult } from "@e-gaop/shared";

// Strict allowlist: every token may only contain alphanumerics and a small set of
// safe punctuation. Any shell metacharacter (;&|$`(){}<>!*?[]'"~\\\n) is rejected.
const ALLOWED_INIT_TOKEN_RE = /^[a-zA-Z0-9_\-./:=+@%^]+$/;
const ALLOWED_INIT_BINARY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
// Dangerous binaries that must never run in a sandbox, regardless of allowlist.
const FORBIDDEN_INIT_BINARIES = new Set([
  "rm", "dd", "mkfs", "mke2fs", "shred", "mount", "umount", "fdisk", "parted",
  "reboot", "halt", "poweroff", "shutdown", "kill", "killall", "pkill",
  "chmod", "chown", "usermod", "passwd", "su", "sudo", "nc", "ncat", "socat",
]);
const ALLOWED_IMAGES = /^(egaop-[\w-]+|ghcr\.io\/ismael-2001\/the-kubernetes-of-ai-agents\/[\w-]+):[\w.-]+$/;

function isInitCommandSafe(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  if (cmd.length > 4096) return false;

  const tokens = cmd.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 128) return false;

  const binary = tokens[0]!.split("/").pop()!;
  if (!ALLOWED_INIT_BINARY_RE.test(binary) || FORBIDDEN_INIT_BINARIES.has(binary)) return false;

  for (const token of tokens) {
    if (!ALLOWED_INIT_TOKEN_RE.test(token)) return false;
  }
  return true;
}

export class DockerSandboxDriver implements SandboxDriver {
  private docker: Docker;
  private readonly activeContainers = new Set<string>();
  private readonly maxContainers: number;
  private readonly running = { current: 0 };
  private readonly waiters: Array<{ resolve: (value: boolean) => void; timer?: NodeJS.Timeout }> = [];
  private readonly seccompProfile: string | undefined;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
    this.maxContainers = Math.max(1, parseInt(process.env.SANDBOX_MAX_CONTAINERS || "20", 10));
    const profile = process.env.SANDBOX_SECCOMP_PROFILE;
    this.seccompProfile = profile && profile.trim().length > 0 ? profile.trim() : undefined;
  }

  private async acquireContainerSlot(timeoutMs: number): Promise<boolean> {
    if (this.running.current < this.maxContainers) {
      this.running.current++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const waiter: { resolve: (value: boolean) => void; timer?: NodeJS.Timeout } = { resolve };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            resolve(false);
          }
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private releaseContainerSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve(true);
    } else if (this.running.current > 0) {
      this.running.current--;
    }
  }

  async createSandbox(spec: SandboxSpec): Promise<SandboxResult> {
    if (!(await this.acquireContainerSlot(5000))) {
      throw Object.assign(new Error(`Sandbox container limit of ${this.maxContainers} reached`), { code: "RESOURCE_EXHAUSTED" });
    }

    const NanoCpus = spec.cpu ? Math.round(parseFloat(spec.cpu) * 1_000_000_000) : 500_000_000;
    const memoryBytes = spec.memory ? parseInt(spec.memory) * 1024 * 1024 : 512 * 1024 * 1024;

    const HostConfig: Docker.ContainerCreateOptions["HostConfig"] & { Runtime?: string; SecurityOpt?: string[]; Tmpfs?: Record<string, string> } = {
      Memory: memoryBytes,
      NanoCpus,
      NetworkMode: "egaop-sandbox",
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      // P1-5: read-only rootfs; agent scratch space is tmpfs only.
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=256m,mode=1777",
        "/workspace": "rw,nosuid,size=256m,mode=1777",
      },
    };

    if (this.seccompProfile) {
      HostConfig.SecurityOpt.push(`seccomp=${this.seccompProfile}`);
    }

    if (spec.isolationLevel === "Enhanced") {
      HostConfig.Runtime = "runsc";
    } else if (spec.isolationLevel === "Maximum") {
      HostConfig.Runtime = "firecracker";
    }

    const containerImage = spec.image || "egaop-base-runtime:latest";
    if (!ALLOWED_IMAGES.test(containerImage)) {
      this.releaseContainerSlot();
      throw Object.assign(new Error(`Image not in allowlist: ${containerImage}`), { code: "INVALID_ARGUMENT" });
    }

    let container: Docker.Container | null = null;
    try {
      container = await this.docker.createContainer({
        Image: containerImage,
        name: `egaop-agent-${spec.executionId}`,
        // P1-5: server.js lives outside /workspace so /workspace can be tmpfs.
        Cmd: ["node", "/opt/egaop/server.js"],
        Env: Object.entries(spec.envVars ?? {}).map(([k, v]) => `${k}=${v}`),
        HostConfig,
        Labels: {
          "egaop.agent.id": spec.agentId,
          "egaop.execution.id": spec.executionId,
          "egaop.plane": "execution",
        },
      });

      await container.start();
      this.activeContainers.add(container.id);

      let ipAddress = "unknown";
      try {
        const info = await container.inspect();
        const networks = info.NetworkSettings?.Networks || {};
        const sandboxNet = networks["egaop-sandbox"];
        if (sandboxNet?.IPAddress) ipAddress = sandboxNet.IPAddress;
      } catch {
        // non-fatal
      }

      const initOutputs: string[] = [];
      const initCmds = spec.initCommands ?? [];
      for (const cmd of initCmds) {
        if (!isInitCommandSafe(cmd)) {
          initOutputs.push("BLOCKED: command rejected by security policy");
          continue;
        }
        try {
          const execInstance = await container.exec({
            Cmd: ["sh", "-c", cmd],
            AttachStdout: true,
            AttachStderr: true,
          });
          const stream = await execInstance.start({ Detach: false, Tty: false });
          const output = await new Promise<string>((resolve) => {
            let data = "";
            stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            stream.on("end", () => resolve(data));
          });
          initOutputs.push(output);
        } catch (e: unknown) {
          const eObj = e instanceof Error ? e : new Error(String(e));
          initOutputs.push(`ERROR: ${eObj.message}`);
        }
      }

      return { sandboxId: container.id, status: "Running", ipAddress, initOutputs };
    } catch (e: unknown) {
      if (container) {
        try { await container.remove({ force: true }); } catch { /* non-fatal */ }
      }
      this.releaseContainerSlot();
      throw e;
    }
  }

  async terminateSandbox(sandboxId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(sandboxId);
      await container.remove({ force: true });
      this.activeContainers.delete(sandboxId);
      this.releaseContainerSlot();
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    const ids = Array.from(this.activeContainers);
    for (const id of ids) {
      try {
        await this.docker.getContainer(id).remove({ force: true });
      } catch {
        // non-fatal
      }
      this.activeContainers.delete(id);
      this.releaseContainerSlot();
    }
  }

  get activeContainerCount(): number {
    return this.activeContainers.size;
  }

  async getSandboxStatus(sandboxId: string): Promise<{ status: string; cpu: number; memory: number; startedAt: Date | null }> {
    try {
      const container = this.docker.getContainer(sandboxId);
      const info = await container.inspect();
      const state = info.State;
      return {
        status: state.Status || "unknown",
        cpu: 0,
        memory: 0,
        startedAt: state.StartedAt ? new Date(state.StartedAt) : null,
      };
    } catch (e: unknown) {
      const statusCode = (e as Record<string, unknown>)?.statusCode;
      if (statusCode === 404) return { status: "NotFound", cpu: 0, memory: 0, startedAt: null };
      return { status: "Unknown", cpu: 0, memory: 0, startedAt: null };
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
