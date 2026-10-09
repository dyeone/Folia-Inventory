-- SKU numbers roll over after 9999 into A001 … A999, B001 … Z999 (a
-- four-character suffix always fits the label). The max-suffix functions
-- now understand both spellings: a plain number counts as itself, a letter
-- code counts as 10000 + (letter - 'A') * 999 + (digits - 1), so A001 =
-- 10000 and Z999 = 35973. The app also scans letter-coded SKUs itself, so
-- numbering stays right before this runs; this keeps the SQL honest.
--
-- Apply by hand in the Supabase SQL editor.

create or replace function inventory_max_sku_suffix(p_brand text) returns int
language sql stable as $$
  select coalesce(max(
    case
      when sku ~ '-\d+$' then (regexp_match(sku, '-(\d+)$'))[1]::int
      when sku ~ '-[A-Z]\d{3}$' then 10000
        + (ascii((regexp_match(sku, '-([A-Z])\d{3}$'))[1]) - 65) * 999
        + (regexp_match(sku, '-[A-Z](\d{3})$'))[1]::int - 1
    end), 0)
  from inventory_items
  where "brandId" = p_brand and (sku ~ '-\d+$' or sku ~ '-[A-Z]\d{3}$');
$$;

create or replace function inventory_max_sku_suffix() returns int
language sql stable as $$
  select coalesce(max(
    case
      when sku ~ '-\d+$' then (regexp_match(sku, '-(\d+)$'))[1]::int
      when sku ~ '-[A-Z]\d{3}$' then 10000
        + (ascii((regexp_match(sku, '-([A-Z])\d{3}$'))[1]) - 65) * 999
        + (regexp_match(sku, '-[A-Z](\d{3})$'))[1]::int - 1
    end), 0)
  from inventory_items
  where sku ~ '-\d+$' or sku ~ '-[A-Z]\d{3}$';
$$;

insert into applied_migrations (id) values ('0051_sku_letter_serials')
  on conflict (id) do nothing;
