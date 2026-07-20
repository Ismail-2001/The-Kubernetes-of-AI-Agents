-- Migration 004 rollback: Users and Auth
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS user_sessions;
DROP TABLE IF EXISTS users;
DROP TYPE IF EXISTS user_role;
