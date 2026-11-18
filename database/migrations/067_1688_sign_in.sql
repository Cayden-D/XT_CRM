BEGIN;

CREATE TABLE auth_1688_identities (
  app_key text NOT NULL,
  ali_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_key, ali_id),
  UNIQUE (app_key, user_id)
);

CREATE TABLE auth_1688_sign_in_states (
  state_hash text PRIMARY KEY,
  browser_challenge text NOT NULL,
  app_key text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_1688_sign_in_states_expiry ON auth_1688_sign_in_states(expires_at);

COMMIT;
