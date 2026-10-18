BEGIN;

-- Customer-service accounts of a performance connection: the main account plus every sub-account.
-- Each platform account may be bound to at most one CRM user and vice versa within a shop.
CREATE TABLE perf_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  login_id text NOT NULL,
  platform_user_id text,
  member_id text,
  is_main boolean NOT NULL DEFAULT false,
  platform_status text,
  present boolean NOT NULL DEFAULT true,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  binding_revision integer NOT NULL DEFAULT 1 CHECK (binding_revision > 0),
  relations_synced_until timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, login_id),
  UNIQUE (connection_id, user_id)
);
CREATE INDEX idx_perf_agents_tenant ON perf_agents(tenant_id, connection_id);
CREATE INDEX idx_perf_agents_user ON perf_agents(tenant_id, user_id) WHERE user_id IS NOT NULL;

-- Platform buyers keyed by the encrypted main-account openUid (falls back to openUid, then Taobao nick).
CREATE TABLE perf_buyers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  buyer_key text NOT NULL,
  open_uid text,
  admin_open_uid text,
  taobao_nick text,
  first_chat_at timestamptz,
  last_chat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, buyer_key)
);

-- One agent x one conversation x one Beijing calendar day, as returned by wangwang.chat.relation.query.
CREATE TABLE perf_chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES perf_buyers(id) ON DELETE CASCADE,
  cid text NOT NULL,
  chat_date date NOT NULL,
  last_peer_at timestamptz NOT NULL,
  messages_synced_at timestamptz,
  message_cursor bigint,
  needs_sync boolean NOT NULL DEFAULT true,
  transferred boolean NOT NULL DEFAULT false,
  buyer_messages integer NOT NULL DEFAULT 0,
  agent_messages integer NOT NULL DEFAULT 0,
  auto_replies integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, cid, chat_date)
);
CREATE INDEX idx_perf_sessions_report ON perf_chat_sessions(tenant_id, connection_id, chat_date, agent_id);
CREATE INDEX idx_perf_sessions_pending ON perf_chat_sessions(connection_id, needs_sync) WHERE needs_sync;

-- Message metadata only. Buyer text is masked by the platform; agent text is not stored in this stage.
CREATE TABLE perf_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES perf_chat_sessions(id) ON DELETE CASCADE,
  uuid text NOT NULL,
  direction smallint NOT NULL CHECK (direction IN (0,1)),
  sent_at timestamptz NOT NULL,
  length integer NOT NULL DEFAULT 0 CHECK (length >= 0),
  message_types text[] NOT NULL DEFAULT '{}',
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (connection_id, uuid)
);
CREATE INDEX idx_perf_messages_session ON perf_chat_messages(session_id, sent_at);

-- A buyer turn starts at the first buyer message after an agent reply (or session start);
-- reply_at is the first manual agent reply to it. Thresholds are applied at report time.
CREATE TABLE perf_chat_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES perf_chat_sessions(id) ON DELETE CASCADE,
  turn_index integer NOT NULL CHECK (turn_index >= 0),
  turn_at timestamptz NOT NULL,
  reply_at timestamptz,
  buyer_messages integer NOT NULL CHECK (buyer_messages > 0),
  UNIQUE (session_id, turn_index),
  CHECK (reply_at IS NULL OR reply_at >= turn_at)
);
CREATE INDEX idx_perf_turns_time ON perf_chat_turns(tenant_id, turn_at);

CREATE TABLE perf_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule','manual')),
  backfill_days integer CHECK (backfill_days BETWEEN 1 AND 90),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  phase text,
  worker_id text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- At most one queued or running sync per shop.
CREATE UNIQUE INDEX uq_perf_sync_runs_active ON perf_sync_runs(connection_id) WHERE status IN ('queued','running');
CREATE INDEX idx_perf_sync_runs_recent ON perf_sync_runs(tenant_id, connection_id, created_at DESC);

-- Agents may view their own reception metrics.
UPDATE roles SET permissions=permissions||'["performance:read_own"]'::jsonb
WHERE code='sales_rep' AND NOT permissions ? 'performance:read_own';

COMMENT ON COLUMN perf_agents.user_id IS 'CRM user bound to this customer-service account; one user per account per shop';
COMMENT ON TABLE perf_chat_messages IS 'Wangwang message metadata; selfLoginId decides the owning agent, buyer content is masked by 1688';

COMMIT;
