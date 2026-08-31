-- The DBOS system database, created at first boot.
--
-- DBOS creates its own SCHEMA on launch (run_migrations) but does NOT create
-- the DATABASE, and exits FATAL "database ... does not exist" if it is absent.
-- Same trap the Convex backend has, and the same reason deploy/71 pre-creates
-- it on the VM.
CREATE ROLE myos_dbos LOGIN PASSWORD 'replica';
CREATE DATABASE myos_dbos OWNER myos_dbos;
