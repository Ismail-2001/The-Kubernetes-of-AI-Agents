import { GrpcServer } from "../grpc/server";

describe("GrpcServer mTLS fail-closed", () => {
  it("refuses to start when enableMTLS is set without certDir", async () => {
    const server = new GrpcServer({
      serviceName: "test.svc",
      port: 0,
      healthPort: 0,
      services: [],
      enableMTLS: true,
    });

    await expect(server.start()).rejects.toThrow(/enableMTLS requires certDir/);
  });
});
