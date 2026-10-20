-- Incremental 平台商品 sync: products modified after the watermark are fetched with alibaba.product.list.get's
-- startModifyTime/endModifyTime. The watermark only advances when a sync pass reads its whole window.
ALTER TABLE integration_1688_connections
  ADD COLUMN IF NOT EXISTS listings_synced_through timestamptz,
  ADD COLUMN IF NOT EXISTS listings_full_synced_at timestamptz;
