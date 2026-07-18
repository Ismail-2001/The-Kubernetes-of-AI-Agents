import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  scanStream: jest.fn(),
  ping: jest.fn(),
  disconnect: jest.fn(),
  on: jest.fn(),
};
jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

import { server } from "../index";

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/memory.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")]
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

describe("Memory Plane", () => {
  let port: number;
  let client: any;
  let healthClient: ReturnType<typeof createHealthClient>;

  beforeAll(async () => {
    port = await startServer(server);
    const MemoryService = egaopProto.egaop.v1.MemoryService;
    client = new MemoryService(`localhost:${port}`, grpc.credentials.createInsecure());
    healthClient = createHealthClient(port);
  });

  afterAll(() => {
    healthClient.close();
    server.forceShutdown();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Write", () => {
    it("should store data in Redis with default working memory TTL", (done) => {
      mockRedis.setex.mockResolvedValue("OK");

      client.Write({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "working",
        key: "conversation",
        data: { message: "Hello" }
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("success");
        expect(response.version).toMatch(/^rev-/);
        expect(mockRedis.setex).toHaveBeenCalledTimes(1);
        const [key, ttl] = mockRedis.setex.mock.calls[0];
        expect(key).toBe("egaop:default:agent-1:working:conversation");
        expect(ttl).toBe(300);
        done();
      });
    });

    it("should use default TTL for session memory", (done) => {
      mockRedis.setex.mockResolvedValue("OK");

      client.Write({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "session",
        key: "prefs",
        data: { theme: "dark" }
      }, (err: any, _response: any) => {
        expect(err).toBeNull();
        const [, ttl] = mockRedis.setex.mock.calls[0];
        expect(ttl).toBe(86400);
        done();
      });
    });
  });

  describe("Read", () => {
    it("should return found=true when data exists", (done) => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ message: "Hello" }));

      client.Read({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "working",
        key: "conversation"
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.found).toBe(true);
        expect(response.data).toBeDefined();
        done();
      });
    });

    it("should return found=false when key missing", (done) => {
      mockRedis.get.mockResolvedValue(null);

      client.Read({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "working",
        key: "nonexistent"
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.found).toBe(false);
        done();
      });
    });

    it("should handle Redis errors gracefully", (done) => {
      mockRedis.get.mockRejectedValue(new Error("Connection refused"));

      client.Read({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "working",
        key: "fail"
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.found).toBe(false);
        done();
      });
    });
  });

  describe("Delete", () => {
    it("should remove key from Redis", (done) => {
      mockRedis.del.mockResolvedValue(1);

      client.Delete({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "working",
        key: "temp-data"
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("success");
        expect(mockRedis.del).toHaveBeenCalledWith("egaop:default:agent-1:working:temp-data");
        done();
      });
    });
  });

  describe("List", () => {
    it("should return entries from Redis scan stream", (done) => {
      const mockStream: any = (() => {
        let idx = 0;
        const chunks = [["egaop:default:agent-1:working:k1", "egaop:default:agent-1:working:k2"]];
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (idx < chunks.length) {
                return Promise.resolve({ value: chunks[idx++], done: false });
              }
              return Promise.resolve({ done: true });
            }
          })
        };
      })();
      mockRedis.scanStream.mockReturnValue(mockStream);
      mockRedis.get.mockImplementation((key: string) => {
        if (key === "egaop:default:agent-1:working:k1") return Promise.resolve(JSON.stringify({ val: 1 }));
        if (key === "egaop:default:agent-1:working:k2") return Promise.resolve(JSON.stringify({ val: 2 }));
        return Promise.resolve(null);
      });

      client.List({
        agent_id: "agent-1",
        namespace: "default",
        memory_type: "working"
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.entries).toHaveLength(2);
        expect(response.entries[0].key).toBe("k1");
        expect(response.entries[1].key).toBe("k2");
        expect(response.entries[0].data).toBeDefined();
        expect(response.entries[1].data).toBeDefined();
        done();
      });
    });
  });

  describe("Health Check", () => {
    it("should return SERVING when Redis is reachable", (done) => {
      mockRedis.ping.mockResolvedValue("PONG");

      healthClient.Check({}, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("SERVING");
        done();
      });
    });

    it("should return NOT_SERVING when Redis is down", (done) => {
      mockRedis.ping.mockRejectedValue(new Error("Connection refused"));

      healthClient.Check({}, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("NOT_SERVING");
        done();
      });
    });
  });
});
