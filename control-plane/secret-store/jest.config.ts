const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
  setupFiles: ["<rootDir>/src/__tests__/env-setup.ts"],
};

module.exports = config;
