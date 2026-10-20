-- 1688 category names (platform-wide, so not per tenant), cached from alibaba.category.get to show names instead of IDs.
BEGIN;
CREATE TABLE integration_1688_categories (
  cat_id bigint PRIMARY KEY,
  name varchar(200) NOT NULL,
  parent_id bigint,
  is_leaf boolean,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE integration_1688_categories IS '1688 类目名称缓存（alibaba.category.get），用于把类目 ID 显示为名称和路径';
COMMIT;
