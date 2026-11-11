-- Buyer names from the conversation list: the full Taobao nick, and the platform's masked loginId (e.g. "王*") for
-- buyers without one. Before this, the nick was kept only for buyers with no encrypted id, so most buyers showed an id tail.
ALTER TABLE perf_buyers ADD COLUMN login_id text;
COMMENT ON COLUMN perf_buyers.taobao_nick IS '会话列表返回的淘宝昵称（最近一次）';
COMMENT ON COLUMN perf_buyers.login_id IS '会话列表返回的脱敏登录名，仅在没有淘宝昵称时用于显示';
