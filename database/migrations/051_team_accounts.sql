-- Sub-accounts: a supervisor (销售经理) opens and manages accounts for their own team. parent_user_id is the supervisor
-- who opened the account; the super administrator still manages everyone.
BEGIN;
ALTER TABLE users ADD COLUMN parent_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_users_parent ON users(parent_user_id) WHERE parent_user_id IS NOT NULL;
COMMENT ON COLUMN users.parent_user_id IS '开设该子账号的主管；为空表示由超级管理员管理';
UPDATE roles SET permissions=permissions||'["user:manage_team"]'::jsonb
  WHERE code='sales_manager' AND NOT permissions ? 'user:manage_team';
COMMIT;
