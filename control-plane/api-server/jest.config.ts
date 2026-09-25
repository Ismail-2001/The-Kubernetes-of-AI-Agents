const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Live-stack suites (require a running api-server + postgres on localhost).
  // Excluded from the hermetic default run; opt in with E2E=1 (npm run test:e2e).
  ...(process.env.E2E === "1"
    ? {}
    : {
        testPathIgnorePatterns: [
          "/node_modules/",
          "src/__tests__/(agent-workflow-e2e|e2e-integration|chaos-integration)\\.test\\.ts$",
        ],
      }),
  clearMocks: true,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
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

module.exports = config;
