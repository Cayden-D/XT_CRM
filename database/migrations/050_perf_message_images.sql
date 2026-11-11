-- Pictures sent in chats: buyer messages list them in `urls`, an agent's picture arrives as a bare image link. Kept
-- before masking (masking breaks the digits in CDN paths) and cleared with the text after 90 days.
ALTER TABLE perf_chat_messages ADD COLUMN image_urls text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN perf_chat_messages.image_urls IS '消息中的图片地址（阿里图片域名），与文本一样 90 天后清除';
