-- Refund amounts: the refund list reports goods (refundPayment/applyPayment) and shipping (refundCarriage/applyCarriage)
-- separately, both in fen. Sales are counted with shipping (order totalAmount), so refunds must include refunded shipping too.
BEGIN;

ALTER TABLE perf_refunds
  ADD COLUMN IF NOT EXISTS refund_carriage numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS apply_carriage numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE perf_refunds ADD COLUMN IF NOT EXISTS refund_total numeric(14,2) GENERATED ALWAYS AS (refund_amount + refund_carriage) STORED;
COMMENT ON COLUMN perf_refunds.refund_amount IS 'Goods refunded (refundPayment, fen converted to yuan)';
COMMENT ON COLUMN perf_refunds.refund_carriage IS 'Shipping refunded (refundCarriage, fen converted to yuan)';
COMMENT ON COLUMN perf_refunds.refund_total IS 'Goods plus shipping refunded; what reports and payroll deduct';

COMMIT;
