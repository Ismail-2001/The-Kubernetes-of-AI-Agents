DROP TRIGGER IF EXISTS trg_prevent_audit_entries_update ON audit_entries;
DROP FUNCTION IF EXISTS prevent_audit_entries_modification();
DROP TABLE IF EXISTS audit_entries;
