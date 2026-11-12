-- 外贸业务员 (and the sub-accounts supervisors open with it) collect, list and complete products themselves: shop and
-- catalogue reading, drafts and publishing, creating products and filling in their details. Deleting products and
-- managing shop authorisations stay with supervisors.
UPDATE roles SET permissions=permissions||to_jsonb(ARRAY(SELECT p FROM unnest(ARRAY['integration:read','integration:publish','product:create','product:update']) p WHERE NOT roles.permissions ? p))
  WHERE code='sales_rep';
