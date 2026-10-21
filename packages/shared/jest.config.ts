import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/__tests__/**",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/grpc/server.ts",
    "!src/grpc/trace-propagation.ts",
    "!src/telemetry/index.ts",
    "!src/metrics/index.ts",
    "!src/db.ts",
    "!src/tls.ts",
    "!src/config/secrets.ts",
  ],
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80,
    },
  },
};

export default config;
