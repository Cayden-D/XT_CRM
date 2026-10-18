-- Agent-side chat text (buyer text is masked by the platform). Only masked text is kept, for 90 days; the derived
-- flags drive off-platform trading alerts and reply-quality metrics and are kept with the message.
ALTER TABLE perf_chat_messages
  ADD COLUMN text_masked text,
  ADD COLUMN char_count integer,
  ADD COLUMN flags text[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_perf_messages_offsite ON perf_chat_messages (connection_id, sent_at DESC)
  WHERE flags && ARRAY['phone','wechat','qq','offsite','external_link'];

COMMENT ON COLUMN perf_chat_messages.text_masked IS '客服消息文本（手机号、微信号、QQ 号及 6 位以上数字已遮盖），保留 90 天；买家消息为空';
COMMENT ON COLUMN perf_chat_messages.char_count IS '客服消息有效字数（不含链接、标点）；未采集文本时为空';
COMMENT ON COLUMN perf_chat_messages.flags IS 'phone/wechat/qq/offsite/external_link 站外交易风险；curt 生硬用语；short 极短回复；image 图片或卡片';
