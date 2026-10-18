-- Resumable history backfill for the performance sync.
-- A requested backfill is stored on the shop and continued by every later run, newest day first, until reached;
-- *_synced_from records how far back each feed is complete, so a throttled or interrupted run never starts over.
BEGIN;

ALTER TABLE integration_1688_perf_connections
  ADD COLUMN IF NOT EXISTS backfill_from timestamptz,
  ADD COLUMN IF NOT EXISTS orders_synced_from timestamptz,
  ADD COLUMN IF NOT EXISTS refunds_synced_from timestamptz;
ALTER TABLE perf_agents ADD COLUMN IF NOT EXISTS relations_synced_from timestamptz;

-- Existing cursors came from the default 7-day first sync. Assume no more history than that:
-- older days are read again on backfill, never skipped.
UPDATE perf_agents SET relations_synced_from=relations_synced_until-interval '7 days' WHERE relations_synced_until IS NOT NULL AND relations_synced_from IS NULL;
UPDATE integration_1688_perf_connections SET orders_synced_from=orders_synced_until-interval '7 days' WHERE orders_synced_until IS NOT NULL AND orders_synced_from IS NULL;
UPDATE integration_1688_perf_connections SET refunds_synced_from=refunds_synced_until-interval '7 days' WHERE refunds_synced_until IS NOT NULL AND refunds_synced_from IS NULL;

COMMIT;
