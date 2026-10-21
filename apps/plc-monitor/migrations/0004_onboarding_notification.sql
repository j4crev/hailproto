ALTER TABLE monitor_alerts DROP CONSTRAINT monitor_alerts_category_check;
ALTER TABLE monitor_alerts ADD CONSTRAINT monitor_alerts_category_check
  CHECK (category IN ('unexpected-operation', 'coverage-lost', 'invalid-operation-log', 'export-gap', 'onboarding-enrollment'));
