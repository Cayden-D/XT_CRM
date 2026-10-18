-- P10: customer attachments on private OSS, and overdue customers in the follow-up list.
BEGIN;

CREATE TABLE IF NOT EXISTS cust_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES perf_buyers(id) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('image','file')),
  name varchar(120) NOT NULL,
  mime varchar(120) NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 2097152),
  -- Private object: customer-attachments/<tenant>/<buyer at upload>/<uuid>.<ext>; only reachable through short-lived signed links.
  storage_key varchar(300) NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cust_attachments_buyer ON cust_attachments(buyer_id, created_at DESC);
COMMENT ON TABLE cust_attachments IS 'Images and files attached to an online customer; bytes live in private OSS';

-- Overdue customers (past their purchase cycle) appear under 待跟进 until someone follows up after they became overdue.
ALTER TABLE cust_settings ADD COLUMN IF NOT EXISTS overdue_followup boolean NOT NULL DEFAULT true;

COMMIT;
