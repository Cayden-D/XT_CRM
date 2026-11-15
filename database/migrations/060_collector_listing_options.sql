BEGIN;

DROP INDEX idx_1688_collection_queue_one_target;
CREATE INDEX idx_1688_collection_queue_targets ON integration_1688_collection_queue_settings(tenant_id,updated_at,connection_id) WHERE enabled;

ALTER TABLE collected_products
  ADD COLUMN target_connection_id uuid REFERENCES integration_1688_connections(id) ON DELETE SET NULL,
  ADD COLUMN use_default_listing_shop boolean NOT NULL DEFAULT true,
  ADD COLUMN price_adjustment_percent numeric(7,2) NOT NULL DEFAULT 0 CHECK (price_adjustment_percent > -100),
  ADD CHECK (target_connection_id IS NULL OR NOT use_default_listing_shop);

CREATE VIEW collection_listing_shops AS
SELECT q.tenant_id,q.connection_id,c.display_name,q.updated_at AS enabled_at
FROM integration_1688_collection_queue_settings q
JOIN integration_1688_agent_settings a ON a.connection_id=q.connection_id AND a.tenant_id=q.tenant_id AND a.enabled
JOIN integration_1688_connections c ON c.id=q.connection_id AND c.tenant_id=q.tenant_id AND c.status='connected'
WHERE q.enabled;

CREATE OR REPLACE FUNCTION enqueue_1688_collected_product() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF NEW.source <> '1688' OR NEW.product_id IS NOT NULL THEN RETURN NEW; END IF;

  IF NOT NEW.use_default_listing_shop AND NEW.target_connection_id IS NULL THEN
    IF TG_OP='UPDATE' AND (OLD.use_default_listing_shop OR OLD.target_connection_id IS NOT NULL) THEN
      UPDATE integration_1688_collection_queue_jobs
      SET status='cancelled',message='采集时选择仅保存到采集箱。',updated_at=now()
      WHERE collected_product_id=NEW.id AND tenant_id=NEW.tenant_id
        AND status IN ('blocked','failed') AND product_id IS NULL AND draft_id IS NULL;
    END IF;
    RETURN NEW;
  END IF;

  SELECT connection_id INTO target FROM collection_listing_shops
  WHERE tenant_id=NEW.tenant_id AND (NEW.use_default_listing_shop OR connection_id=NEW.target_connection_id)
  ORDER BY enabled_at,connection_id LIMIT 1;
  IF target IS NULL THEN RETURN NEW; END IF;

  INSERT INTO integration_1688_collection_queue_jobs(tenant_id,connection_id,collected_product_id,actor_id,source_updated_at)
  VALUES(NEW.tenant_id,target,NEW.id,NEW.collected_by,NEW.updated_at)
  ON CONFLICT(collected_product_id) DO NOTHING;

  IF TG_OP='UPDATE' AND (
    OLD.target_connection_id IS DISTINCT FROM NEW.target_connection_id
    OR OLD.use_default_listing_shop IS DISTINCT FROM NEW.use_default_listing_shop
    OR OLD.price_adjustment_percent IS DISTINCT FROM NEW.price_adjustment_percent
    OR (OLD.source_category_id IS DISTINCT FROM NEW.source_category_id AND NEW.source_category_id ~ '^[1-9][0-9]{0,19}$')
  ) THEN
    UPDATE integration_1688_collection_queue_jobs
    SET connection_id=target,actor_id=NEW.collected_by,source_updated_at=NEW.updated_at,
        status='queued',phase='screening',attempts=0,available_at=now(),
        worker_id=NULL,lease_until=NULL,message=NULL,report='{}'::jsonb,updated_at=now()
    WHERE collected_product_id=NEW.id AND tenant_id=NEW.tenant_id
      AND status IN ('blocked','failed','cancelled') AND product_id IS NULL AND draft_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
