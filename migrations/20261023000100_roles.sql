-- Spec §4 "Roles": the runtime role and its grants. Runs as the database owner.
--
-- nacre_app (api + worker) may read and append everywhere, and update only lifecycle columns.
-- It never gets DELETE or TRUNCATE (TRUNCATE skips row triggers), owns nothing and can't create
-- objects, so it can't drop or disable the append-only triggers either.
-- The role is created NOLOGIN with no password: Marcus gives it LOGIN and a password on Railway
-- with \password, never in a file (migrations/README.md).

-- migrate:up
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nacre_app') THEN
    CREATE ROLE nacre_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO nacre_app;

-- Listed by name, not ON ALL TABLES, so dbmate's schema_migrations stays out of reach and a new
-- table gets no grants until a migration says so (the grant-matrix check then fails CI).
GRANT SELECT, INSERT ON
  scopes, agents, oauth_clients, agent_tokens, oauth_auth_codes, events, event_content, entities,
  extraction_runs, claims, evidence_spans, beliefs, belief_versions, belief_version_claims,
  belief_embeddings, activity_log, model_calls, jobs
  TO nacre_app;

GRANT UPDATE ON extraction_runs, jobs TO nacre_app;
GRANT UPDATE (last_used_at, revoked_at, rotated_at) ON agent_tokens TO nacre_app;
GRANT UPDATE (approved_at, disabled_at) ON oauth_clients TO nacre_app;
GRANT UPDATE (used_at) ON oauth_auth_codes TO nacre_app;
-- status_reason too: the §4 claims trigger allows it alongside status.
GRANT UPDATE (status, status_reason) ON claims TO nacre_app;
GRANT UPDATE (expired_at) ON belief_versions TO nacre_app;

GRANT USAGE ON SEQUENCE jobs_job_id_seq TO nacre_app;

-- migrate:down
-- The role itself is cluster-wide (shared by every database on the server), so it is left in
-- place; only this database's grants are removed.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nacre_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM nacre_app;
REVOKE USAGE ON SCHEMA public FROM nacre_app;
