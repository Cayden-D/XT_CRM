-- P9: the remaining attribution schemes.
--   5 memo_flag              : the seller memo names an agent ("@name"), or the order flag colour maps to an agent per shop
--   7 order_payment_split    : the order/payment split ratio becomes a setting
--   8 owner_only             : the customer's owning agent
--   9 owner_collaborator_split: owner and closing agent share the order
-- A customer without a hand-set owner is owned by the agent credited for their earliest paid order (scheme 2), unless switched off.
BEGIN;

ALTER TABLE cust_profiles
  ADD COLUMN IF NOT EXISTS owner_source varchar(10) CHECK (owner_source IN ('manual','auto')),
  ADD COLUMN IF NOT EXISTS owner_assigned_at timestamptz;
UPDATE cust_profiles SET owner_source='manual',owner_assigned_at=updated_at WHERE owner_agent_id IS NOT NULL AND owner_source IS NULL;

ALTER TABLE perf_orders
  ADD COLUMN IF NOT EXISTS seller_memo varchar(500),
  ADD COLUMN IF NOT EXISTS seller_flag smallint;

CREATE TABLE IF NOT EXISTS perf_flag_rules (
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  flag smallint NOT NULL CHECK (flag BETWEEN 1 AND 10),
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, flag)
);
COMMENT ON TABLE perf_flag_rules IS 'Scheme 5: which agent an order flag colour credits, per shop';

ALTER TABLE perf_settings
  ADD COLUMN IF NOT EXISTS split_order_share numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (split_order_share BETWEEN 0.1 AND 0.9),
  ADD COLUMN IF NOT EXISTS owner_share numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (owner_share BETWEEN 0.1 AND 0.9),
  ADD COLUMN IF NOT EXISTS auto_assign_owner boolean NOT NULL DEFAULT true;

ALTER TABLE perf_order_attributions DROP CONSTRAINT IF EXISTS perf_order_attributions_basis_check;
ALTER TABLE perf_order_attributions ADD CONSTRAINT perf_order_attributions_basis_check
  CHECK (basis IN ('order_reply','payment_reply','payment_day_chat','owner','memo_mention','memo_flag'));

-- Every order is recomputed once so the new schemes are filled in.
UPDATE perf_orders SET attribution_key=NULL;

COMMIT;
