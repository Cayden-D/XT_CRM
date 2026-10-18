BEGIN;

-- Online customers are 1688 buyers (perf_buyers). Until now only buyers seen in chats had a row;
-- buyers who ordered without chatting get one too, keyed by the order's encrypted buyer id.
INSERT INTO perf_buyers(tenant_id,connection_id,buyer_key,open_uid,first_chat_at,last_chat_at)
SELECT DISTINCT ON (o.connection_id,o.buyer_open_uid) o.tenant_id,o.connection_id,o.buyer_open_uid,o.buyer_open_uid,NULL::timestamptz,NULL::timestamptz
FROM perf_orders o
WHERE o.buyer_open_uid IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM perf_buyer_identities i WHERE i.connection_id=o.connection_id AND i.open_uid=o.buyer_open_uid)
ON CONFLICT (connection_id,buyer_key) DO NOTHING;
INSERT INTO perf_buyer_identities(connection_id,open_uid,buyer_id)
SELECT b.connection_id,b.buyer_key,b.id FROM perf_buyers b
WHERE NOT EXISTS (SELECT 1 FROM perf_buyer_identities i WHERE i.connection_id=b.connection_id AND i.open_uid=b.buyer_key)
  AND b.buyer_key NOT LIKE 'tb:%'
ON CONFLICT DO NOTHING;

-- Manually maintained profile of an online customer (the platform exposes no names or contacts).
CREATE TABLE cust_profiles (
  buyer_id uuid PRIMARY KEY REFERENCES perf_buyers(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(100),
  wangwang_id varchar(100),
  phone varchar(30),
  wechat varchar(60),
  email citext,
  qq varchar(20),
  address varchar(200),
  member_identity varchar(20),
  purchase_type varchar(20) CHECK (purchase_type IN ('distribution','procurement')),
  sales_channels text[] NOT NULL DEFAULT '{}',
  cycle_mode varchar(10) NOT NULL DEFAULT 'system' CHECK (cycle_mode IN ('system','custom')),
  cycle_days integer CHECK (cycle_days BETWEEN 1 AND 3650),
  note varchar(100),
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  owner_agent_id uuid REFERENCES perf_agents(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cycle_mode='system' OR cycle_days IS NOT NULL)
);
CREATE INDEX idx_cust_profiles_tenant ON cust_profiles(tenant_id);
CREATE INDEX idx_cust_profiles_search ON cust_profiles USING gin ((coalesce(name,'')||' '||coalesce(wangwang_id,'')||' '||coalesce(phone,'')||' '||coalesce(note,'')) gin_trgm_ops);

CREATE TABLE cust_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(30) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE cust_buyer_tags (
  buyer_id uuid NOT NULL REFERENCES perf_buyers(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES cust_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (buyer_id, tag_id)
);
CREATE INDEX idx_cust_buyer_tags_tag ON cust_buyer_tags(tag_id);

CREATE TABLE cust_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES perf_buyers(id) ON DELETE CASCADE,
  content varchar(500) NOT NULL CHECK (length(trim(content)) > 0),
  method varchar(20) NOT NULL CHECK (method IN ('wangwang','other')),
  need_follow_up boolean NOT NULL,
  next_follow_up_at timestamptz,
  -- Set when a later follow-up is written, so only the newest plan counts as due.
  superseded boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (need_follow_up OR next_follow_up_at IS NULL)
);
CREATE INDEX idx_cust_followups_buyer ON cust_followups(buyer_id, created_at DESC);
CREATE INDEX idx_cust_followups_due ON cust_followups(tenant_id, next_follow_up_at) WHERE need_follow_up AND NOT superseded;

-- Platform-derived purchase statistics, refreshed by the sync worker.
CREATE TABLE cust_stats (
  buyer_id uuid PRIMARY KEY REFERENCES perf_buyers(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  paid_orders integer NOT NULL DEFAULT 0,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  avg_order_amount numeric(14,2),
  first_paid_at timestamptz,
  last_paid_at timestamptz,
  avg_interval_days numeric(8,2),
  inquiry_days integer NOT NULL DEFAULT 0,
  last_chat_at timestamptz,
  unpaid_order_id text,
  unpaid_amount numeric(14,2),
  unpaid_placed_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cust_stats_connection ON cust_stats(connection_id, last_paid_at DESC);

-- Segment thresholds; editable by managers.
CREATE TABLE cust_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Cumulative paid amount: below level_platinum = 普通, below level_vip = 白金, else VIP.
  level_platinum numeric(14,2) NOT NULL DEFAULT 1000,
  level_vip numeric(14,2) NOT NULL DEFAULT 10000,
  -- Average order value: below price_mid = 低, below price_high = 一般, else 高.
  price_mid numeric(14,2) NOT NULL DEFAULT 100,
  price_high numeric(14,2) NOT NULL DEFAULT 500,
  -- Paid orders needed to count as 忠诚客户 (2+ is 老客户).
  loyal_orders integer NOT NULL DEFAULT 5 CHECK (loyal_orders >= 3),
  -- Cycle used for overdue checks when a customer has only one purchase and no custom cycle.
  default_cycle_days integer NOT NULL DEFAULT 30 CHECK (default_cycle_days BETWEEN 1 AND 3650),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (level_platinum < level_vip AND price_mid < price_high)
);

UPDATE roles SET permissions=permissions||'["customer_ops:read","customer_ops:update","customer_ops:manage"]'::jsonb
WHERE code='sales_manager' AND NOT permissions ? 'customer_ops:manage';
UPDATE roles SET permissions=permissions||'["customer_ops:read","customer_ops:update"]'::jsonb
WHERE code IN ('sales_rep','order_specialist') AND NOT permissions ? 'customer_ops:update';
UPDATE roles SET permissions=permissions||'["customer_ops:read"]'::jsonb
WHERE code IN ('executive','finance') AND NOT permissions ? 'customer_ops:read';

COMMENT ON TABLE cust_profiles IS 'Manually maintained details of a 1688 buyer; owner_agent_id is the member-owning agent for future attribution schemes';

COMMIT;
