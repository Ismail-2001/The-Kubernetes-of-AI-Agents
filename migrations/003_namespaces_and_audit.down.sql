-- Migration 003 rollback: Namespaces and Audit
DROP TRIGGER IF EXISTS trg_prevent_audit_log_update ON audit_log;
DROP FUNCTION IF EXISTS prevent_audit_log_modification;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS namespaces;
