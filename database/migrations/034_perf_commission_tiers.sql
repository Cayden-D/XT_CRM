-- P11: tiered commission and a zero floor, per shop.
--   flat   : each agent's own rate from perf_pay_rules (unchanged behaviour)
--   tiered : the shop's bands for everyone; base salaries stay per agent
--     progressive: each part of the month's net credited sales is paid at its band's rate (超额累进)
--     whole      : the whole net amount is paid at the rate of the highest band reached (全额累进)
BEGIN;

ALTER TABLE perf_pay_settings
  ADD COLUMN IF NOT EXISTS commission_mode varchar(10) NOT NULL DEFAULT 'flat' CHECK (commission_mode IN ('flat','tiered')),
  ADD COLUMN IF NOT EXISTS tier_style varchar(12) NOT NULL DEFAULT 'progressive' CHECK (tier_style IN ('progressive','whole')),
  -- [{"from":0,"rate":0.01},{"from":50000,"rate":0.015}] — yuan thresholds ascending from 0, rates as fractions.
  ADD COLUMN IF NOT EXISTS commission_tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- When true, refunds can reduce commission to zero but not below.
  ADD COLUMN IF NOT EXISTS commission_floor_zero boolean NOT NULL DEFAULT false;

-- How each line's commission was reached (bands used, floor applied), kept with the payroll for audit.
ALTER TABLE perf_payroll_lines ADD COLUMN IF NOT EXISTS commission_detail jsonb;

COMMIT;
