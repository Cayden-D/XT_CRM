-- Connecting a collector by approving it in the CRM instead of copying a key. The collector keeps a random verifier
-- and opens the CRM with its SHA-256 (the challenge); a signed-in user approves; the collector redeems the verifier once
-- for a collector key. Neither the key nor the verifier ever appears in a URL.
BEGIN;
CREATE TABLE product_collector_connects (
  challenge char(43) PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
COMMIT;
