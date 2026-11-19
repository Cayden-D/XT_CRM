BEGIN;

-- A confirmed draft publication is the authority for both manual and Agent paths.
-- Keep a running worker's identity so it can still save its final AI report.
CREATE FUNCTION sync_1688_published_collection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'published' OR NEW.offer_id IS NULL THEN RETURN NEW; END IF;

  UPDATE integration_1688_collection_queue_jobs q
  SET status='published',phase='publishing',draft_id=NEW.id,product_id=NEW.product_id,
      message='已发布；审核状态以平台为准。',
      worker_id=CASE WHEN q.status='processing' THEN q.worker_id ELSE NULL END,
      lease_until=CASE WHEN q.status='processing' THEN q.lease_until ELSE NULL END,
      updated_at=now()
  WHERE q.tenant_id=NEW.tenant_id AND q.connection_id=NEW.connection_id
    AND (q.draft_id=NEW.id OR q.product_id=NEW.product_id OR EXISTS (
      SELECT 1 FROM collected_products cp WHERE cp.id=q.collected_product_id
        AND cp.tenant_id=NEW.tenant_id AND cp.product_id=NEW.product_id
    ));

  UPDATE collected_products SET processing_status='published',updated_at=now()
  WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND processing_status<>'published';
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_1688_published_collection
AFTER INSERT OR UPDATE OF status,offer_id ON integration_1688_publish_drafts
FOR EACH ROW EXECUTE FUNCTION sync_1688_published_collection();

-- Repair historical successes whose old queue failure still shows in the UI.
UPDATE integration_1688_collection_queue_jobs q
SET status='published',phase='publishing',draft_id=d.id,product_id=d.product_id,
    message='已发布；审核状态以平台为准。',
    worker_id=CASE WHEN q.status='processing' THEN q.worker_id ELSE NULL END,
    lease_until=CASE WHEN q.status='processing' THEN q.lease_until ELSE NULL END,
    updated_at=now()
FROM integration_1688_publish_drafts d
WHERE d.status='published' AND d.offer_id IS NOT NULL
  AND q.tenant_id=d.tenant_id AND q.connection_id=d.connection_id
  AND q.status<>'published'
  AND (q.draft_id=d.id OR q.product_id=d.product_id OR EXISTS (
    SELECT 1 FROM collected_products cp WHERE cp.id=q.collected_product_id
      AND cp.tenant_id=d.tenant_id AND cp.product_id=d.product_id
  ));

UPDATE collected_products cp SET processing_status='published',updated_at=now()
WHERE cp.processing_status<>'published' AND EXISTS (
  SELECT 1 FROM integration_1688_publish_drafts d
  WHERE d.tenant_id=cp.tenant_id AND d.product_id=cp.product_id
    AND d.status='published' AND d.offer_id IS NOT NULL
);

COMMIT;
