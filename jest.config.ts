const config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  clearMocks: true,
  transformIgnorePatterns: ["node_modules/(?!testcontainers)"],
  testTimeout: 300000,
  globals: {
    "ts-jest": {
      tsconfig: {
        types: ["jest", "node"],
        esModuleInterop: true,
        module: "commonjs",
        target: "es2022",
        moduleResolution: "node",
      },
    },
  },
};

module.exports = config;
