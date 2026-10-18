-- Agent working hours for response-time metrics.
-- An inquiry that arrives outside working hours starts its response clock at the next opening (Beijing time);
-- if an agent answered before the shop opened, the actual wait is used. Applied at query time, so a change re-scores history.
BEGIN;

ALTER TABLE perf_settings
  ADD COLUMN IF NOT EXISTS work_hours_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS work_start time NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS work_end time NOT NULL DEFAULT '22:00';
ALTER TABLE perf_settings DROP CONSTRAINT IF EXISTS perf_settings_work_hours;
ALTER TABLE perf_settings ADD CONSTRAINT perf_settings_work_hours CHECK (work_start < work_end);

CREATE OR REPLACE FUNCTION perf_response_clock(turn_at timestamptz, enabled boolean, work_start time, work_end time) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT enabled THEN turn_at
    WHEN (turn_at AT TIME ZONE 'Asia/Shanghai')::time < work_start THEN ((turn_at AT TIME ZONE 'Asia/Shanghai')::date + work_start) AT TIME ZONE 'Asia/Shanghai'
    WHEN (turn_at AT TIME ZONE 'Asia/Shanghai')::time >= work_end THEN ((turn_at AT TIME ZONE 'Asia/Shanghai')::date + 1 + work_start) AT TIME ZONE 'Asia/Shanghai'
    ELSE turn_at END
$$;

CREATE OR REPLACE FUNCTION perf_response_seconds(turn_at timestamptz, reply_at timestamptz, clock timestamptz) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN reply_at IS NULL THEN NULL
    WHEN reply_at < clock THEN extract(epoch FROM reply_at - turn_at)
    ELSE extract(epoch FROM reply_at - clock) END
$$;

COMMIT;
