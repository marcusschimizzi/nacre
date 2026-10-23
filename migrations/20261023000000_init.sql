-- Spec §4 DDL (slice-1-spec.md v0.2.5), transcribed verbatim between the markers below.
-- Grants live in the next migration (roles). Runs as the database owner.

-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------- Guards ----------
CREATE FUNCTION nacre_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END $$;

-- Immutable version rows: the only allowed change is setting expired_at once.
CREATE FUNCTION nacre_close_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME; END IF;
  IF OLD.expired_at IS NOT NULL
     -- 'search' is excluded: generated columns are not yet computed in a BEFORE trigger's NEW row
     OR (to_jsonb(NEW) - 'expired_at' - 'search') IS DISTINCT FROM (to_jsonb(OLD) - 'expired_at' - 'search') THEN
    RAISE EXCEPTION '% rows are immutable except closing expired_at once', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- Claims are immutable except status (each transition is also written to activity_log).
CREATE FUNCTION nacre_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME; END IF;
  IF (to_jsonb(NEW) - 'status' - 'status_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'status_reason') THEN
    RAISE EXCEPTION '% rows are immutable except status', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION nacre_sens_rank(s text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s WHEN 'normal' THEN 0 WHEN 'private' THEN 1 WHEN 'restricted' THEN 2 END
$$;

-- ---------- Scopes, agents, tokens ----------
CREATE TABLE scopes (
  scope_id        text PRIMARY KEY,                 -- 'personal'; later 'work', 'health', 'project:<name>'
  parent_scope_id text REFERENCES scopes,           -- slice 5: 'project:x' is part of 'work'
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO scopes (scope_id, description)
VALUES ('personal', 'Default scope (Decided: in slice 1 everything lands here, including Claude Code)');

CREATE TABLE agents (
  agent_id     text PRIMARY KEY,                    -- 'claude-code', 'grok-bot'
  display_name text NOT NULL,
  client_kind  text NOT NULL,                       -- client software; several agents may share one later
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

-- Minimal OAuth 2.1 (§9.3). One owner, one resource, no scopes.
CREATE TABLE oauth_clients (
  client_id     text PRIMARY KEY,                   -- 'cli_<ulid>', issued by dynamic client registration
  client_name   text,                               -- self-asserted; shown on the consent page
  redirect_uris text[] NOT NULL,                    -- https or loopback only; matched exactly
  metadata      jsonb NOT NULL,                     -- the registration request as received
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,                        -- first approved consent; unapproved clients expire after 24 h
  disabled_at   timestamptz
);

CREATE TABLE agent_tokens (
  token_id      text PRIMARY KEY,                   -- 'tok_<ulid>', also the public prefix of the token string
  agent_id      text NOT NULL REFERENCES agents,
  secret_hash   bytea NOT NULL,                     -- HMAC-SHA256(server pepper, secret); secret never stored
  kind          text NOT NULL DEFAULT 'static'
                  CHECK (kind IN ('static','oauth_access','oauth_refresh')),
  oauth_client_id text REFERENCES oauth_clients,    -- OAuth tokens only
  grant_id      text,                               -- 'grt_<ulid>': one approved consent; revoking it revokes every token in it
  resource      text,                               -- audience; OAuth tokens: 'https://api.nacre.so/mcp'; static: NULL (/mcp and /v1/*)
  rotated_at    timestamptz,                        -- refresh tokens: set when used; a second use revokes the grant
  read_scopes   text[] NOT NULL DEFAULT '{*}',      -- slice 1: full scope; slice 5 narrows
  write_scopes  text[] NOT NULL DEFAULT '{*}',
  label_ceiling text NOT NULL DEFAULT 'restricted'
                  CHECK (label_ceiling IN ('normal','private','restricted')),
  rights        text[] NOT NULL DEFAULT '{read,write}',
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  CHECK (kind = 'static' OR (oauth_client_id IS NOT NULL AND grant_id IS NOT NULL
                             AND resource IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX agent_tokens_grant_idx ON agent_tokens (grant_id) WHERE grant_id IS NOT NULL;

CREATE TABLE oauth_auth_codes (
  code_hash      bytea PRIMARY KEY,                 -- HMAC-SHA256(server pepper, code); code never stored
  client_id      text NOT NULL REFERENCES oauth_clients,
  agent_id       text NOT NULL REFERENCES agents,   -- chosen on the consent page (default 'grok-bot')
  grant_id       text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,                     -- PKCE, S256 only
  resource       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,              -- created_at + 5 minutes
  used_at        timestamptz                        -- single use; a second use revokes the grant
);

-- ---------- Layer 0: events ----------
CREATE TABLE events (
  event_id          text PRIMARY KEY,               -- 'evt_<ulid>'
  schema_version    smallint NOT NULL DEFAULT 1,    -- event shape version (design §12.4)
  kind              text NOT NULL CHECK (kind IN
                      ('message','remember','tool_result','import','native_intake',
                       'user_edit','review_decision','retraction','purge','system')),
  role              text CHECK (role IN ('user','assistant','tool','system')),
  source_client     text NOT NULL,                  -- 'claude-code', 'grok-bot'
  source_label      text,                           -- e.g. 'native:chatgpt@2026-10-05' (slice 5)
  agent_id          text NOT NULL REFERENCES agents,
  token_id          text REFERENCES agent_tokens,   -- NULL only for owner/system events
  replica_id        text,                           -- slice 8
  device_seq        bigint,                         -- slice 8
  client_event_id   text NOT NULL,                  -- idempotency key from the client
  principal         text NOT NULL DEFAULT 'owner',  -- one human principal for now
  session_id        text,
  observed_at       timestamptz NOT NULL,           -- when it was said (device clock)
  observed_tz       text,                           -- IANA zone of the device, for "tomorrow"
  received_at       timestamptz NOT NULL DEFAULT now(), -- hub clock, never client-set
  clock_flags       text[] NOT NULL DEFAULT '{}',   -- 'drift','future' now; 'late' in slice 8
  key_id            text,                           -- slice 8: per-event key
  content_hash      bytea NOT NULL,                 -- sha256 now; keyed HMAC in slice 8
  hash_alg          text NOT NULL DEFAULT 'sha256',
  content_type      text NOT NULL DEFAULT 'text/plain',
  scope_hint        text,
  scope_id          text NOT NULL DEFAULT 'personal' REFERENCES scopes,
  sensitivity       text NOT NULL DEFAULT 'normal'
                      CHECK (sensitivity IN ('normal','private','restricted')),
  trust_tier        text NOT NULL CHECK (trust_tier IN
                      ('user_typed','user_confirmed','agent_inferred','native_memory','tool_or_web_derived')),
  tainted           boolean NOT NULL DEFAULT false,
  explicit_remember boolean NOT NULL DEFAULT false,
  refs_event_ids    text[] NOT NULL DEFAULT '{}',   -- retraction/correction targets
  redactions        jsonb NOT NULL DEFAULT '[]',    -- [{"kind":"api_key","count":1}]; secrets are stripped
                                                    --   from the stored body before hashing (§6.2, §17 Q2)
  metadata          jsonb NOT NULL DEFAULT '{}',    -- client extras (cwd, prompt_id, model)
  UNIQUE (agent_id, client_event_id)
);
CREATE INDEX events_session_idx  ON events (session_id, observed_at);
CREATE INDEX events_received_idx ON events (received_at DESC);
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();

-- Content is split out so slice 8 can encrypt / purge one table and keep the events row as the tombstone.
CREATE TABLE event_content (
  event_id        text PRIMARY KEY REFERENCES events,
  body            text,                             -- plaintext (NFC, secrets redacted) in slices 1–7
  body_ciphertext bytea,                            -- slice 8
  CHECK (body IS NOT NULL OR body_ciphertext IS NOT NULL)
);
CREATE TRIGGER event_content_append_only BEFORE UPDATE OR DELETE ON event_content
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();
-- Slice 8 swaps this trigger for one that lets only the purge role null the content.

-- ---------- Entities (exists so FKs exist; unused until slice 4) ----------
CREATE TABLE entities (
  entity_id      text PRIMARY KEY,                  -- 'ent_<ulid>'
  type           text NOT NULL CHECK (type IN
                   ('person','organization','place','project','goal','agent','tool','artifact','event','topic')),
  canonical_name text NOT NULL,
  external_ref   text,                              -- e.g. a Wake id for projects and goals
  scope_id       text NOT NULL DEFAULT 'personal' REFERENCES scopes,
  sensitivity    text NOT NULL DEFAULT 'normal',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Extraction runs (PROV "activity") ----------
CREATE TABLE extraction_runs (
  run_id          text PRIMARY KEY,                 -- 'run_<ulid>'
  event_id        text NOT NULL REFERENCES events,
  extractor       text NOT NULL,                    -- 'fastpass-v1'
  model           text NOT NULL,                    -- provider/model
  model_version   text,                             -- pinned snapshot string returned by the provider
  prompt_id       text NOT NULL,                    -- 'extract-claims'
  prompt_hash     text NOT NULL,                    -- sha256 of the template (not the inputs)
  config_hash     text NOT NULL,                    -- thresholds, schema version, context window
  input_event_ids text[] NOT NULL,                  -- target + context events, in order
  raw_output      jsonb,                            -- kept so replays reuse outputs (design §12.4)
  status          text NOT NULL CHECK (status IN ('running','ok','error','skipped')),
  skip_reason     text,                             -- 'sensitivity:private', 'role:assistant', 'empty', 'budget'
  error           text,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(10,6),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
-- Runs are updated once (running -> final). No deletes.
CREATE TRIGGER runs_no_delete BEFORE DELETE ON extraction_runs
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();

-- ---------- Layer 1: claims + evidence ----------
CREATE TABLE claims (
  claim_id          text PRIMARY KEY,               -- 'clm_<ulid>'
  event_id          text NOT NULL REFERENCES events,  -- primary source
  extraction_run_id text NOT NULL REFERENCES extraction_runs,
  text              text NOT NULL,                  -- normalized statement
  subject_text      text NOT NULL,                  -- 'user', 'Dana', 'this repo'
  subject_entity_id text REFERENCES entities,       -- slice 4
  attribute         text NOT NULL,                  -- snake_case, model-proposed
  value             text NOT NULL,
  value_kind        text NOT NULL CHECK (value_kind IN ('literal','entity','unknown')),
  object_entity_id  text REFERENCES entities,       -- slice 4 (entity value -> relationship)
  structured        jsonb,
  assertion_type    text NOT NULL CHECK (assertion_type IN
                      ('stated','inferred','preference','instruction','plan','decision',
                       'hypothesis','quoted_third_party')),
  time_phrase       text,                           -- verbatim ('next month'); resolved in code
  valid_from        timestamptz,
  valid_to          timestamptz,
  valid_precision   text NOT NULL DEFAULT 'unknown'
                      CHECK (valid_precision IN ('day','week','month','year','unknown')),
  time_source       text NOT NULL DEFAULT 'inferred_from_event_time'
                      CHECK (time_source IN ('explicit','relative','inferred_from_event_time')),
  confidence        real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  confidence_reason text,
  salience          jsonb,                          -- slice 6
  checks            jsonb NOT NULL DEFAULT '{}',    -- {"quote":"exact","value_in_quote":true}
  scope_id          text NOT NULL REFERENCES scopes,
  sensitivity       text NOT NULL,
  status            text NOT NULL CHECK (status IN
                      ('candidate','promoted','held','queued','rejected','retracted')),
  status_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_event_idx ON claims (event_id);
CREATE TRIGGER claims_status_only BEFORE UPDATE OR DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION nacre_status_only();

CREATE TABLE evidence_spans (
  span_id     text PRIMARY KEY,                     -- 'spn_<ulid>'
  claim_id    text NOT NULL REFERENCES claims,
  event_id    text NOT NULL REFERENCES events,
  span_start  int NOT NULL,                         -- code-point offsets into event_content.body
  span_end    int NOT NULL,
  quote       text NOT NULL,                        -- = substring of body at the offsets (asserted)
  match_kind  text NOT NULL CHECK (match_kind IN ('exact','normalized')),
  occurrences int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (span_end > span_start)
);
CREATE TRIGGER spans_append_only BEFORE UPDATE OR DELETE ON evidence_spans
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();

-- ---------- Layer 2: beliefs + versions ----------
CREATE TABLE beliefs (
  belief_id         text PRIMARY KEY,               -- 'blf_<ulid>', stable across versions
  subject_text      text NOT NULL,
  subject_key       text NOT NULL,                  -- lower(trim(collapse_ws(subject_text)))
  subject_entity_id text REFERENCES entities,       -- slice 4 backfill
  attribute         text NOT NULL,
  attribute_key     text NOT NULL,
  kind              text NOT NULL DEFAULT 'ordinary', -- durable kinds in slice 6
  cardinality       text CHECK (cardinality IN ('one','many')), -- slice 3, literal beliefs only
  scope_id          text NOT NULL REFERENCES scopes,
  sensitivity       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- One belief per question while subjects are text. Slice 4 adds an entity-keyed index and merges.
CREATE UNIQUE INDEX beliefs_question_uq ON beliefs (scope_id, subject_key, attribute_key)
  WHERE subject_entity_id IS NULL;

CREATE TABLE belief_versions (
  version_id            text PRIMARY KEY,           -- 'blv_<ulid>'
  belief_id             text NOT NULL REFERENCES beliefs,
  statement             text NOT NULL,              -- display sentence, includes the subject
  value                 text NOT NULL,
  value_norm            text NOT NULL,
  value_kind            text NOT NULL,
  valid_at              timestamptz,
  valid_at_precision    text NOT NULL DEFAULT 'unknown',
  invalid_at            timestamptz,
  invalid_at_precision  text NOT NULL DEFAULT 'unknown',
  created_at            timestamptz NOT NULL DEFAULT now(),  -- record time start
  expired_at            timestamptz,                          -- record time end
  status                text NOT NULL CHECK (status IN
                          ('active','superseded','disputed','retracted','suppressed')),
  confidence            real NOT NULL,
  strength              real,                        -- slice 6
  reason_labels         text[] NOT NULL DEFAULT '{}',
  committed_by          text NOT NULL,               -- 'rule:promote-v1', 'user_edit'; later 'review:<id>'
  supersedes_version_id text REFERENCES belief_versions,     -- slice 3
  scope_id              text NOT NULL REFERENCES scopes,
  sensitivity           text NOT NULL,
  search                tsvector GENERATED ALWAYS AS
                          (to_tsvector('english', statement || ' ' || value)) STORED
);
-- Deliberately NO unique "one current version per belief" index: with valid time, several versions
-- of one belief are legitimately current at once ("lived in A until Nov 1", "lives in B from Nov 1").
CREATE INDEX blv_current_idx ON belief_versions (belief_id) WHERE expired_at IS NULL;
CREATE INDEX blv_search_idx  ON belief_versions USING gin (search);
CREATE TRIGGER blv_close_only BEFORE UPDATE OR DELETE ON belief_versions
  FOR EACH ROW EXECUTE FUNCTION nacre_close_only();

CREATE TABLE belief_version_claims (                 -- supporting / contradicting evidence
  version_id  text NOT NULL REFERENCES belief_versions,
  claim_id    text NOT NULL REFERENCES claims,
  relation    text NOT NULL DEFAULT 'supports' CHECK (relation IN ('supports','contradicts')),
  attached_at timestamptz NOT NULL DEFAULT now(),    -- keeps "support as of date D" answerable
  PRIMARY KEY (version_id, claim_id)
);
CREATE TRIGGER bvc_append_only BEFORE UPDATE OR DELETE ON belief_version_claims
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();

-- Embeddings in their own table: a model change is a new `model` value plus a backfill.
CREATE TABLE belief_embeddings (
  version_id text NOT NULL REFERENCES belief_versions,
  model      text NOT NULL,
  embedding  vector(1536) NOT NULL,                  -- dimension fixed per model (§10.5)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, model)
);
CREATE INDEX belief_emb_hnsw ON belief_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------- Activity log (every change and every read) ----------
CREATE TABLE activity_log (
  entry_id    text PRIMARY KEY,                      -- 'act_<ulid>'
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,                         -- see §13.2
  actor       text NOT NULL,                         -- agent_id, 'worker', 'rule:<id>', 'owner'
  token_id    text REFERENCES agent_tokens,
  request_id  text,
  target_kind text,
  target_id   text,
  event_ids   text[] NOT NULL DEFAULT '{}',
  claim_ids   text[] NOT NULL DEFAULT '{}',
  old_value   jsonb,                                 -- slice 8: encrypted under the source event key
  new_value   jsonb,
  reason      text,
  details     jsonb NOT NULL DEFAULT '{}',           -- reads: query digest, returned ids, ranks, latency
  undo_of     text REFERENCES activity_log           -- slice 3
);
CREATE INDEX activity_at_idx     ON activity_log (at DESC);
CREATE INDEX activity_target_idx ON activity_log (target_kind, target_id);
CREATE TRIGGER activity_append_only BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();

-- ---------- Model calls: every paid API call, for the daily budget (§12.3) ----------
CREATE TABLE model_calls (
  call_id      text PRIMARY KEY,                     -- 'mcl_<ulid>'
  at           timestamptz NOT NULL DEFAULT now(),
  purpose      text NOT NULL CHECK (purpose IN ('extract','embed_belief','embed_query')),
  provider     text NOT NULL,                        -- 'openai' only in slice 1; 'anthropic' from the later Haiku 5.5 adapter
  model        text NOT NULL,                        -- model string returned by the provider
  ref_id       text,                                 -- run_id, version_id or read activity id
  input_tokens int NOT NULL DEFAULT 0,
  cached_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,              -- includes reasoning tokens
  cost_usd     numeric(10,6) NOT NULL,               -- computed from a pinned price table in config
  latency_ms   int
);
CREATE INDEX model_calls_at_idx ON model_calls (at DESC);
CREATE TRIGGER model_calls_append_only BEFORE UPDATE OR DELETE ON model_calls
  FOR EACH ROW EXECUTE FUNCTION nacre_forbid_mutation();
-- Heavy work (consolidation, backfills, re-extraction) never writes here: it runs on local
-- subscription agents under the slice 7 job contract, not on the API budget.

-- ---------- Jobs (no Redis) ----------
CREATE TABLE jobs (
  job_id     bigserial PRIMARY KEY,
  kind       text NOT NULL,                          -- 'extract', 'embed'
  ref_id     text NOT NULL,                          -- event_id / version_id
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts   int NOT NULL DEFAULT 0,
  run_after  timestamptz NOT NULL DEFAULT now(),
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id)
);
CREATE INDEX jobs_ready_idx ON jobs (run_after) WHERE status = 'queued';


-- migrate:down
DROP TABLE
  jobs, model_calls, activity_log, belief_embeddings, belief_version_claims, belief_versions,
  beliefs, evidence_spans, claims, extraction_runs, entities, event_content, events,
  oauth_auth_codes, agent_tokens, oauth_clients, agents, scopes;
DROP FUNCTION nacre_sens_rank(text), nacre_status_only(), nacre_close_only(), nacre_forbid_mutation();
-- `up` creates the extension IF NOT EXISTS; dropping it here is safe because nothing else uses it.
DROP EXTENSION IF EXISTS vector;
