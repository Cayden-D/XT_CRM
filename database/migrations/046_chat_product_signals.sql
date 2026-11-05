BEGIN;
ALTER TABLE perf_keywords
  ADD COLUMN purpose text NOT NULL DEFAULT 'general' CHECK (purpose IN ('general','loss_signal','product')),
  ADD COLUMN offer_id text;

CREATE TABLE chat_session_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES perf_chat_sessions(id) ON DELETE CASCADE,
  offer_id text NOT NULL,
  product_name text,
  source text NOT NULL CHECK (source IN ('manual','agent_link','order_after','keyword','ai_text','recent_order')),
  confidence text NOT NULL CHECK (confidence IN ('certain','high','medium','low')),
  evidence_message_uuid text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, offer_id, source)
);
CREATE INDEX idx_chat_session_products_offer ON chat_session_products(tenant_id, offer_id);
COMMIT;
