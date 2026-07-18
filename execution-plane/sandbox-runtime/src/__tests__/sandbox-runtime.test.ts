import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const mockContainer = {
  id: "abc123def456",
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  inspect: jest.fn().mockResolvedValue({
    State: { Status: "running", Running: true, StartedAt: "2025-01-01T00:00:00Z" },
    HostConfig: { NanoCpus: 1000000000 }
  }),
  wait: jest.fn().mockResolvedValue({ StatusCode: 0 }),
};

const mockDocker = {
  createContainer: jest.fn().mockResolvedValue(mockContainer),
  getContainer: jest.fn().mockReturnValue(mockContainer),
  listContainers: jest.fn().mockResolvedValue([]),
  ping: jest.fn().mockResolvedValue("PONG"),
};

jest.mock("dockerode", () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

import { server } from "../index";

const PROTO_PATH = path.resolve(__dirname, "../../../../api/proto/egaop/v1/runtime.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;

function startServer(srv: grpc.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.bindAsync("localhost:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else { srv.start(); resolve(port); }
    });
  });
}

function createHealthClient(port: number) {
  const client = new grpc.Client(`localhost:${port}`, grpc.credentials.createInsecure());
  return {
    Check: (req: any, callback: any) => {
      client.makeUnaryRequest(
        "/grpc.health.v1.Health/Check",
        (v: any) => Buffer.from(JSON.stringify(v)),
        (b: Buffer) => JSON.parse(b.toString()),
        req,
        callback
      );
    },
    close: () => client.close()
  };
}

describe("Sandbox Runtime", () => {
  let port: number;
  let client: any;
  let healthClient: ReturnType<typeof createHealthClient>;

  beforeAll(async () => {
    port = await startServer(server);
    const RuntimeService = egaopProto.egaop.v1.RuntimeService;
    client = new RuntimeService(`localhost:${port}`, grpc.credentials.createInsecure());
    healthClient = createHealthClient(port);
  });

  afterAll(() => {
    healthClient.close();
    server.forceShutdown();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("CreateSandbox", () => {
    it("should create a Docker container and return sandbox ID", (done) => {
      client.CreateSandbox({
        agent_id: "agent-1",
        execution_id: "exec-1",
        isolation_level: "Enhanced",
        resources: { cpu: "0.5", memory: "256" },
        env_vars: {}
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.sandbox_id).toBe("abc123def456");
        expect(response.status).toBe("Running");
        expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
        done();
      });
    });

    it("should call docker.createContainer with NanoCpus and security config", (done) => {
      client.CreateSandbox({
        agent_id: "agent-2",
        execution_id: "exec-2",
        isolation_level: "Maximum",
        resources: { cpu: "1.0", memory: "512" },
        env_vars: {}
      }, (err: any, _response: any) => {
        expect(err).toBeNull();
        const opts = mockDocker.createContainer.mock.calls[0][0];
        expect(opts.HostConfig.NanoCpus).toBe(1000000000);
        expect(opts.HostConfig.SecurityOpt).toContain("no-new-privileges");
        expect(opts.HostConfig.Runtime).toBe("firecracker");
        done();
      });
    });
  });

  describe("GetSandboxStatus", () => {
    it("should return running status from Docker inspect", (done) => {
      client.GetSandboxStatus({ sandbox_id: "abc123def456" }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("running");
        expect(mockDocker.getContainer).toHaveBeenCalledWith("abc123def456");
        expect(mockContainer.inspect).toHaveBeenCalled();
        done();
      });
    });
  });

  describe("TerminateSandbox", () => {
    it("should remove the container with force", (done) => {
      client.TerminateSandbox({ sandbox_id: "abc123def456", reason: "completed" }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.success).toBe(true);
        expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
        done();
      });
    });
  });

  describe("Health Check", () => {
    it("should return SERVING", (done) => {
      healthClient.Check({}, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("SERVING");
        done();
      });
    });
  });
});
