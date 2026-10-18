-- Sync scope: each shop keeps history for a chosen number of days (default 30), and a manual run can be limited to
-- today / the last 7 / the last 30 days. Data already synced outside the range is kept; it is simply not filled further.
ALTER TABLE integration_1688_perf_connections
  ADD COLUMN history_days integer NOT NULL DEFAULT 30 CHECK (history_days IN (7, 30, 60, 90));

-- NULL = full run (new activity plus history up to the shop's range); 1/7/30 = only that many recent Beijing days.
ALTER TABLE perf_sync_runs
  ADD COLUMN scope_days integer CHECK (scope_days IN (1, 7, 30));

COMMENT ON COLUMN integration_1688_perf_connections.history_days IS '历史数据范围（天）：自动同步补齐到这么久以前，超出部分不再补';
COMMENT ON COLUMN integration_1688_perf_connections.backfill_from IS '当前历史补齐目标（每轮同步按 history_days 刷新）';
COMMENT ON COLUMN perf_sync_runs.scope_days IS '本次同步范围：NULL 全部（含历史补齐），1 今天，7 近 7 天，30 近 30 天';
