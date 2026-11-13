-- Teams and their AI: a team is a top-level account (opened by the super administrator, parent_user_id IS NULL) with the
-- sub-accounts it opened. The super administrator sets each team's text and image model and its credits; listing a
-- collected product on 1688 costs credits. The super administrator's own team is not limited.
BEGIN;
CREATE TABLE team_ai_settings (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  text_model varchar(60),
  image_model varchar(60),
  credits integer NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_team_ai_settings_tenant ON team_ai_settings(tenant_id);
COMMENT ON TABLE team_ai_settings IS '团队（顶层账号及其子账号）使用的文字/图片模型和积分余额；为空的模型用系统默认';

CREATE TABLE team_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta integer NOT NULL CHECK (delta <> 0),
  balance_after integer NOT NULL,
  reason varchar(30) NOT NULL CHECK (reason IN ('adjust', 'publish', 'refund')),
  note varchar(200),
  ref_id uuid,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_team_credit_ledger_owner ON team_credit_ledger(owner_user_id, created_at DESC);
COMMENT ON TABLE team_credit_ledger IS '团队积分流水：超级管理员调整、采集商品上架扣分、平台明确拒绝后退回';
COMMIT;
