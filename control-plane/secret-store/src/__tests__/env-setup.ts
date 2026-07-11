// Runs before each test file — sets env vars needed by index.ts module-level code
process.env.NODE_ENV = "test";
process.env.EGAOP_MASTER_ENCRYPTION_KEY = "test-master-key-for-unit-tests-only-32chars";
process.env.POSTGRES_HOST = "127.0.0.1";
process.env.POSTGRES_PORT = "5432";
process.env.POSTGRES_DB = "testdb";
process.env.POSTGRES_USER = "testuser";
process.env.POSTGRES_PASSWORD = "testpass";
