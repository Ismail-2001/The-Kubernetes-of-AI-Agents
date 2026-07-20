-- Migration 001 rollback: Memory Plane
DROP TABLE IF EXISTS agent_memory;
DROP EXTENSION IF EXISTS vector;
