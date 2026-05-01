CREATE TABLE IF NOT EXISTS handoff_records (
  id           TEXT PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  from_model   TEXT NOT NULL,
  to_model     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  packet_json  TEXT NOT NULL,
  success      INTEGER NOT NULL DEFAULT 1,
  error_msg    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL,
  last_active         TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  cwd                 TEXT NOT NULL,
  messages_json       TEXT NOT NULL,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0
);
