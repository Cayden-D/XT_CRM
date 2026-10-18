-- Account management: a regular administrator role (everything except managing accounts, which stays with the super
-- administrator) and a per-user session cut-off so disabling, password resets and role changes take effect at once.
BEGIN;

ALTER TABLE users ADD COLUMN sessions_revoked_at timestamptz;
COMMENT ON COLUMN users.sessions_revoked_at IS '早于此时间签发的登录令牌全部失效（停用、重置密码、调整角色时更新）';

INSERT INTO roles(tenant_id, code, name, permissions, is_system)
SELECT t.id, 'admin', '管理员', '["dashboard:*","report:*","account:*","product:*","collection:*","integration:*","performance:*","payroll:*","customer_ops:*","order:*","settlement:*"]'::jsonb, true
FROM tenants t
ON CONFLICT (tenant_id, code) DO NOTHING;

COMMIT;
