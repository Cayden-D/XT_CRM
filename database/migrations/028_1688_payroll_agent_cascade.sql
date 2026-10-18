BEGIN;

-- NO ACTION (027) still fires before the cascaded payroll deletes when a shop or tenant is removed.
-- The application never deletes agents on their own (departed accounts are marked present=false),
-- so payroll rows follow their agent only when the whole shop connection or tenant is deleted.
ALTER TABLE perf_payroll_lines DROP CONSTRAINT perf_payroll_lines_agent_id_fkey,
  ADD CONSTRAINT perf_payroll_lines_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES perf_agents(id) ON DELETE CASCADE;
ALTER TABLE perf_payroll_adjustments DROP CONSTRAINT perf_payroll_adjustments_agent_id_fkey,
  ADD CONSTRAINT perf_payroll_adjustments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES perf_agents(id) ON DELETE CASCADE;

COMMIT;
