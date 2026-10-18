-- 关键词库: the shop's Wangwang keyword list lives on 1688 (it marks matching messages as they are sent, not
-- retroactively). This table mirrors it with a category and who added it, so hits can be grouped and explained.
CREATE TABLE perf_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_1688_perf_connections(id) ON DELETE CASCADE,
  word varchar(20) NOT NULL CHECK (length(btrim(word)) > 0),
  category varchar(20) NOT NULL DEFAULT '其他',
  on_platform boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, word)
);
CREATE INDEX idx_perf_keywords_tenant ON perf_keywords (tenant_id);
-- Hit lookups by word over a period.
CREATE INDEX idx_perf_messages_keywords ON perf_chat_messages USING gin (keywords jsonb_path_ops) WHERE keywords <> '[]'::jsonb;

COMMENT ON TABLE perf_keywords IS '旺旺关键词库（与 1688 平台同步）；created_at 之后的新消息才会被平台标记命中';
COMMENT ON COLUMN perf_keywords.on_platform IS '最近一次与平台核对时该词是否仍在平台词库中';
