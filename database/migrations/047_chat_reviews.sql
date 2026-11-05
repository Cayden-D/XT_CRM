BEGIN;
CREATE TABLE chat_review_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  daily_session_limit integer NOT NULL DEFAULT 200 CHECK (daily_session_limit BETWEEN 0 AND 2000),
  min_real_chars integer NOT NULL DEFAULT 30,
  model text NOT NULL DEFAULT 'qwen3.8-flash',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  review_date date NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  worker_id text,
  lease_until timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 候选数、跳过原因、token、估算费用
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (connection_id, review_date)
);

CREATE TABLE chat_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL UNIQUE REFERENCES perf_chat_sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  run_id uuid REFERENCES chat_review_runs(id) ON DELETE SET NULL,
  chat_date date NOT NULL,
  evidence_level text NOT NULL CHECK (evidence_level IN ('rules_only','thin','sufficient')),
  ai_loss_code text,
  ai_loss_confidence text CHECK (ai_loss_confidence IN ('low','medium')),  -- 看不到买家原话，AI 最高只到 medium
  ai_findings jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{type,summary,message_uuid,excerpt,fact_ref}]
  ai_coaching text,
  model text, prompt_version text,
  input_tokens integer, output_tokens integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','corrected','dismissed')),
  final_loss_code text,
  final_findings jsonb,
  reviewer_note text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  published_at timestamptz,        -- 发布后业务员本人可见
  agent_response text,             -- 业务员申诉或说明
  agent_responded_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_reviews_worklist ON chat_reviews(tenant_id, chat_date, status);
CREATE INDEX idx_chat_reviews_agent ON chat_reviews(agent_id, chat_date);

CREATE TABLE chat_coaching_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  review_id uuid REFERENCES chat_reviews(id) ON DELETE SET NULL,
  title varchar(200) NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','done','dropped')),
  due_date date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_coaching_agent ON chat_coaching_items(tenant_id, agent_id, status);

CREATE TABLE chat_agent_daily_briefs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE CASCADE,
  brief_date date NOT NULL,
  stats jsonb NOT NULL,            -- 由 SQL 算出，模型不产生数字
  summary text,
  supervisor_note text,
  model text, prompt_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, brief_date)
);

UPDATE roles SET permissions=permissions||'["performance:review"]'::jsonb
  WHERE code='sales_manager' AND NOT permissions ? 'performance:review';
UPDATE roles SET permissions=permissions||'["performance:review_read"]'::jsonb
  WHERE code='executive' AND NOT permissions ? 'performance:review_read';
COMMIT;
