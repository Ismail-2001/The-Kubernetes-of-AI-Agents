CREATE TABLE IF NOT EXISTS phase1_test (id serial PRIMARY KEY, msg text);
INSERT INTO phase1_test (msg) VALUES ('persistence_works');
SELECT * FROM phase1_test;
