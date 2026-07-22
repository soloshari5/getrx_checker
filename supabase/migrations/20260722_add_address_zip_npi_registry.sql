-- Adds address/zip intake fields for public-record (NPPES NPI Registry) verification.
-- Safe to run against an already-deployed project (idempotent via IF NOT EXISTS).

ALTER TABLE getrx_prescribers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE getrx_prescribers ADD COLUMN IF NOT EXISTS zip TEXT;

ALTER TABLE osint_checks ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE osint_checks ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE osint_checks ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE osint_checks ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE osint_checks ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id);

ALTER TABLE getrx_prescriptions ADD COLUMN IF NOT EXISTS pharmacy_lat NUMERIC;
ALTER TABLE getrx_prescriptions ADD COLUMN IF NOT EXISTS pharmacy_lng NUMERIC;
