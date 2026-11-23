BEGIN;

-- Stored under each app's own connection: token and service expiration are unrelated.
ALTER TABLE integration_1688_connections ADD COLUMN marketplace_subscription jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE integration_1688_perf_connections ADD COLUMN marketplace_subscription jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN integration_1688_connections.marketplace_subscription IS 'Sanitized app.order.get service periods and resumable 30-day history cursor; no payment data or credentials';
COMMENT ON COLUMN integration_1688_perf_connections.marketplace_subscription IS 'Independent performance-app subscription snapshot and history cursor';

COMMIT;
