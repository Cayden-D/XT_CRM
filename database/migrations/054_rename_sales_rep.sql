-- The role shown as 外贸业务员 is now called 业务员. 002 was changed for new installations; this renames it where the
-- database already exists (only if it still has the old name, so a custom name is left alone).
UPDATE roles SET name='业务员' WHERE code='sales_rep' AND name='外贸业务员';
