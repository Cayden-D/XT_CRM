BEGIN;

-- The performance application has its own AppKey, OAuth grant and refresh cycle.
-- Separate tables keep product-side foreign keys (listings, drafts, queues) from ever
-- referencing a performance grant, and vice versa.
CREATE TABLE integration_1688_perf_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_key text NOT NULL,
  ali_id text NOT NULL,
  member_id text,
  login_id text,
  display_name text NOT NULL,
  token_ciphertext text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','reauthorize','disabled')),
  member_capability text NOT NULL DEFAULT 'unknown' CHECK (member_capability IN ('unknown','available','unavailable')),
  account_role text NOT NULL DEFAULT 'unknown' CHECK (account_role IN ('unknown','main','sub')),
  main_login_id text,
  sub_account_count integer CHECK (sub_account_count >= 0),
  last_tested_at timestamptz,
  last_refreshed_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_key,ali_id)
);
CREATE INDEX idx_1688_perf_connections_tenant ON integration_1688_perf_connections(tenant_id,created_at DESC);

CREATE TABLE integration_1688_perf_oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_key text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_1688_perf_states_expiry ON integration_1688_perf_oauth_states(expires_at);

ALTER TABLE integration_1688_operations
  ADD COLUMN app_purpose text NOT NULL DEFAULT 'product' CHECK (app_purpose IN ('product','performance')),
  ADD COLUMN perf_connection_id uuid REFERENCES integration_1688_perf_connections(id) ON DELETE SET NULL,
  ADD CONSTRAINT integration_1688_operations_purpose_target CHECK (
    (app_purpose='product' AND perf_connection_id IS NULL) OR (app_purpose='performance' AND connection_id IS NULL)
  );

-- Tenant-wide metric definitions. Values are editable; the defaults follow the agreed plan.
CREATE TABLE perf_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  attribution_window_hours integer NOT NULL DEFAULT 72 CHECK (attribution_window_hours BETWEEN 1 AND 720),
  unanswered_threshold_seconds integer NOT NULL DEFAULT 180 CHECK (unanswered_threshold_seconds BETWEEN 10 AND 86400),
  default_scheme text NOT NULL DEFAULT 'order_first' CHECK (default_scheme IN (
    'order_first','payment_first','order_only','payment_only','memo_flag','payment_day_chat','order_payment_split','owner_only','owner_collaborator_split'
  )),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

UPDATE roles SET permissions=permissions||'["performance:read","performance:manage"]'::jsonb
WHERE code='sales_manager' AND NOT permissions ? 'performance:manage';
UPDATE roles SET permissions=permissions||'["performance:read","payroll:read"]'::jsonb
WHERE code='executive' AND NOT permissions ? 'payroll:read';
-- Commission and payroll formulas are owned by the finance role.
UPDATE roles SET permissions=permissions||'["performance:read","payroll:read","payroll:manage"]'::jsonb
WHERE code='finance' AND NOT permissions ? 'payroll:manage';

COMMENT ON TABLE integration_1688_perf_connections IS 'OAuth grants of the independent 1688 performance application; never shared with product connections';
COMMENT ON COLUMN integration_1688_perf_connections.token_ciphertext IS 'AES-256-GCM encrypted OAuth tokens; never returned through API';
COMMENT ON COLUMN perf_settings.default_scheme IS 'Attribution scheme; order_first = 绩效优先给促成下单的客服';

COMMIT;
