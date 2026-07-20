-- Migration 002 rollback: Observability Plane
DROP TABLE IF EXISTS replay_sessions;
DROP TABLE IF EXISTS spans;
