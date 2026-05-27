-- DropIndex
DROP INDEX "Product_specs_gin_idx";

-- DropIndex
DROP INDEX "User_specs_gin_idx";

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "verifiedAt" SET DATA TYPE TIMESTAMP(3);

-- Seed global UnitOfMeasure reference data.
-- This table has no tenantId — it is shared across all tenants.
-- Never delete or change existing codes; variants and products hold hard FKs to these rows.

INSERT INTO "UnitOfMeasure" ("code", "name", "category", "baseUnitCode", "conversion", "isActive") VALUES

  -- Count
  ('EA',   'Each',         'count',  NULL,  NULL,        true),
  ('DOZ',  'Dozen',        'count',  'EA',  12.000000,   true),
  ('PCS',  'Pieces',       'count',  'EA',  1.000000,    true),
  ('BOX',  'Box',          'count',  NULL,  NULL,        true),
  ('PACK', 'Pack',         'count',  NULL,  NULL,        true),
  ('SET',  'Set',          'count',  NULL,  NULL,        true),
  ('PAIR', 'Pair',         'count',  'EA',  2.000000,    true),

  -- Weight
  ('KG',   'Kilogram',     'weight', NULL,  NULL,        true),
  ('G',    'Gram',         'weight', 'KG',  0.001000,    true),
  ('MG',   'Milligram',    'weight', 'KG',  0.000001,    true),
  ('MT',   'Metric Ton',   'weight', 'KG',  1000.000000, true),
  ('LB',   'Pound',        'weight', 'KG',  0.453592,    true),
  ('OZ',   'Ounce',        'weight', 'KG',  0.028350,    true),

  -- Volume
  ('LTR',  'Litre',        'volume', NULL,  NULL,        true),
  ('ML',   'Millilitre',   'volume', 'LTR', 0.001000,    true),
  ('GAL',  'Gallon',       'volume', 'LTR', 3.785411,    true),

  -- Length
  ('M',    'Metre',        'length', NULL,  NULL,        true),
  ('CM',   'Centimetre',   'length', 'M',   0.010000,    true),
  ('MM',   'Millimetre',   'length', 'M',   0.001000,    true),
  ('FT',   'Foot',         'length', 'M',   0.304800,    true),
  ('IN',   'Inch',         'length', 'M',   0.025400,    true),

  -- Area
  ('SQM',  'Square Metre', 'area',   NULL,  NULL,        true),
  ('SQFT', 'Square Foot',  'area',   'SQM', 0.092903,    true),

  -- Time (for service products billed by duration)
  ('HR',   'Hour',         'time',   NULL,  NULL,        true),
  ('DAY',  'Day',          'time',   'HR',  8.000000,    true),
  ('MON',  'Month',        'time',   NULL,  NULL,        true)

ON CONFLICT ("code") DO NOTHING;
