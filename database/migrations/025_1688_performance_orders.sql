BEGIN;

-- Every encrypted buyer id seen in chats (openUid and adminOpenUid). Orders carry a single buyerOpenUid
-- that may equal either one, so orders are linked to chat buyers through this table.
CREATE TABLE perf_buyer_identities (
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  open_uid text NOT NULL,
  buyer_id uuid NOT NULL REFERENCES perf_buyers(id) ON DELETE CASCADE,
  PRIMARY KEY (connection_id, open_uid)
);
CREATE INDEX idx_perf_buyer_identities_buyer ON perf_buyer_identities(buyer_id);
INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id)
SELECT connection_id,open_uid,id FROM perf_buyers WHERE open_uid IS NOT NULL
UNION SELECT connection_id,admin_open_uid,id FROM perf_buyers WHERE admin_open_uid IS NOT NULL
ON CONFLICT DO NOTHING;
CREATE INDEX idx_perf_sessions_buyer ON perf_chat_sessions(buyer_id, chat_date);

-- Read-only mirror of platform orders. Amounts in yuan. No address or contact data is stored.
CREATE TABLE perf_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  order_id text NOT NULL,
  buyer_open_uid text,
  status text NOT NULL,
  business_type text,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  product_amount numeric(18,2) NOT NULL DEFAULT 0,
  shipping_fee numeric(18,2) NOT NULL DEFAULT 0,
  refund_amount numeric(18,2) NOT NULL DEFAULT 0,
  placed_at timestamptz NOT NULL,
  paid_at timestamptz,
  platform_modified_at timestamptz,
  buyer_rate_status integer,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Attribution inputs (window and reply rule) last used; a mismatch or NULL means recompute.
  attribution_key text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, order_id)
);
CREATE INDEX idx_perf_orders_buyer ON perf_orders(connection_id, buyer_open_uid, placed_at);
CREATE INDEX idx_perf_orders_time ON perf_orders(tenant_id, connection_id, placed_at);
CREATE INDEX idx_perf_orders_stale ON perf_orders(connection_id) WHERE attribution_key IS NULL;

-- Refunds; the platform reports amounts in fen, stored here converted to yuan.
CREATE TABLE perf_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  refund_id text NOT NULL,
  order_id text NOT NULL,
  buyer_open_uid text,
  status text NOT NULL,
  dispute_type integer,
  only_refund boolean,
  apply_amount numeric(18,2) NOT NULL DEFAULT 0,
  refund_amount numeric(18,2) NOT NULL DEFAULT 0,
  apply_reason text,
  applied_at timestamptz,
  completed_at timestamptz,
  platform_modified_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, refund_id)
);
CREATE INDEX idx_perf_refunds_order ON perf_refunds(connection_id, order_id);

-- Order credit per scheme. All implemented schemes are kept so finance can compare and switch instantly.
CREATE TABLE perf_order_attributions (
  order_id uuid NOT NULL REFERENCES perf_orders(id) ON DELETE CASCADE,
  scheme text NOT NULL,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  share numeric(6,5) NOT NULL CHECK (share > 0 AND share <= 1),
  basis text NOT NULL CHECK (basis IN ('order_reply','payment_reply','payment_day_chat')),
  session_id uuid REFERENCES perf_chat_sessions(id) ON DELETE SET NULL,
  basis_at timestamptz,
  PRIMARY KEY (order_id, scheme, agent_id)
);
CREATE INDEX idx_perf_attributions_agent ON perf_order_attributions(agent_id, scheme);

ALTER TABLE integration_1688_perf_connections
  ADD COLUMN orders_synced_until timestamptz,
  ADD COLUMN refunds_synced_until timestamptz;

COMMENT ON TABLE perf_order_attributions IS 'Which agent gets credit for an order under each attribution scheme, with the reply that decided it';

COMMIT;
