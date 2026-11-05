-- 1688 offer ids from links in agent messages, taken before masking (masking removes every 6+ digit number, including
-- the id in a link). They are product references rather than contact details, so the 90-day text purge keeps them.
ALTER TABLE perf_chat_messages
  ADD COLUMN linked_offer_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN perf_chat_messages.linked_offer_ids IS '客服消息中 1688 商品链接的商品 ID（遮盖前提取），不随 90 天文本清理删除；买家消息为空';
