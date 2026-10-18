BEGIN;

-- RESTRICT is checked immediately and blocked removing a shop or tenant together with its payroll.
-- NO ACTION still forbids deleting an agent that has payroll on its own, but allows the cascade
-- from the connection/tenant that deletes periods and agents in the same statement.
ALTER TABLE perf_payroll_lines DROP CONSTRAINT perf_payroll_lines_agent_id_fkey,
  ADD CONSTRAINT perf_payroll_lines_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES perf_agents(id) ON DELETE NO ACTION;
ALTER TABLE perf_payroll_adjustments DROP CONSTRAINT perf_payroll_adjustments_agent_id_fkey,
  ADD CONSTRAINT perf_payroll_adjustments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES perf_agents(id) ON DELETE NO ACTION;

COMMIT;
