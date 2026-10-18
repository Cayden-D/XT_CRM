BEGIN;

-- KPI ranking: managers choose metrics and weights; one scheme per tenant.
CREATE TABLE perf_kpi_schemes (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  items jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(items) = 'array')
);

-- "我关注的" report: each user's chosen metric columns.
CREATE TABLE perf_report_favorites (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metrics text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Pay rules per shop, maintained by finance. agent_id NULL is the shop default.
CREATE TABLE perf_pay_settings (
  connection_id uuid PRIMARY KEY REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Bonus for KPI rank 1, 2, 3 ... in yuan.
  rank_bonuses numeric(12,2)[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE perf_pay_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES perf_agents(id) ON DELETE CASCADE,
  base_salary numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  -- Fraction of credited paid sales net of refunds, e.g. 0.0150 = 1.5%.
  commission_rate numeric(6,4) NOT NULL DEFAULT 0 CHECK (commission_rate >= 0 AND commission_rate <= 1)
);
CREATE UNIQUE INDEX uq_perf_pay_rules_agent ON perf_pay_rules(connection_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX uq_perf_pay_rules_default ON perf_pay_rules(connection_id) WHERE agent_id IS NULL;

-- Monthly payroll per shop. Draft periods can be recalculated and adjusted; locked periods are final.
CREATE TABLE perf_payroll_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked')),
  scheme text NOT NULL,
  -- Rules, KPI scheme and settings used for the last calculation.
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  calculated_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  locked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, month)
);
CREATE TABLE perf_payroll_lines (
  period_id uuid NOT NULL REFERENCES perf_payroll_periods(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE RESTRICT,
  base_salary numeric(12,2) NOT NULL,
  credited_orders numeric(12,5) NOT NULL,
  paid_amount numeric(14,2) NOT NULL,
  refund_amount numeric(14,2) NOT NULL,
  commission_rate numeric(6,4) NOT NULL,
  commission numeric(12,2) NOT NULL,
  kpi_score numeric(6,2),
  kpi_rank integer,
  kpi_bonus numeric(12,2) NOT NULL,
  adjustments numeric(12,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  PRIMARY KEY (period_id, agent_id)
);
CREATE TABLE perf_payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES perf_payroll_periods(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES perf_agents(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_perf_payroll_adjustments ON perf_payroll_adjustments(period_id, agent_id);
CREATE INDEX idx_perf_orders_paid ON perf_orders(connection_id, paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX idx_perf_refunds_completed ON perf_refunds(connection_id, completed_at) WHERE status='refundsuccess';

COMMENT ON TABLE perf_payroll_lines IS 'Payroll per customer-service account: base + commission on credited paid sales net of refunds + KPI rank bonus + adjustments';

COMMIT;
