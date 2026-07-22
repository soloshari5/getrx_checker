-- Prescribers (synced from getRx Rails app, or standalone)
CREATE TABLE getrx_prescribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  npi TEXT,
  dea_number TEXT,
  address TEXT,
  zip TEXT,
  state TEXT,
  specialty TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Prescriptions (for fraud pattern detection)
-- When getRx has data, ingest here for analysis
CREATE TABLE getrx_prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescriber_id UUID REFERENCES getrx_prescribers(id),
  patient_hash TEXT,  -- hashed patient identifier (HIPAA)
  drug_name TEXT,
  drug_schedule TEXT, -- II, III, IV, V, or NULL (non-controlled)
  quantity NUMERIC,
  pharmacy_npi TEXT,
  pharmacy_lat NUMERIC,
  pharmacy_lng NUMERIC,
  pharmacy_state TEXT,
  prescribed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_rx_prescriber_time ON getrx_prescriptions(prescriber_id, prescribed_at DESC);

-- OSINT checks
CREATE TABLE osint_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescriber_id UUID REFERENCES getrx_prescribers(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  address TEXT,
  zip TEXT,
  state TEXT,
  checked_at TIMESTAMPTZ DEFAULT now(),
  checked_by UUID REFERENCES auth.users(id),
  risk_score INTEGER DEFAULT 0, -- 0-100
  status TEXT DEFAULT 'pending', -- pending, clean, flagged, reviewed, dismissed
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id),
  raw_results JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE osint_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID REFERENCES osint_checks(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL,
  -- finding_type: 'obituary', 'death_mention', 'credential_found',
  --   'graduation', 'license_mention', 'npi_mention',
  --   'malpractice', 'board_action', 'news_negative',
  --   'social_profile', 'no_results',
  --   'npi_registry_match', 'npi_registry_no_match', 'npi_registry_inactive'
  severity TEXT NOT NULL, -- info, low, medium, high, critical
  title TEXT,
  url TEXT,
  snippet TEXT,
  confidence NUMERIC, -- 0.0 - 1.0
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fraud detection
CREATE TABLE fraud_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescriber_id UUID REFERENCES getrx_prescribers(id),
  alert_type TEXT NOT NULL,
  -- alert_type: 'rx_velocity_spike', 'geographic_anomaly',
  --   'schedule_ii_spike', 'after_hours_surge',
  --   'pharmacy_clustering', 'patient_overlap',
  --   'new_prescriber_ramp', 'duplicate_identity'
  severity TEXT NOT NULL, -- low, medium, high, critical
  details JSONB DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id),
  resolution TEXT, -- dismissed, confirmed_fraud, escalated, etc.
  notes TEXT
);

-- Configuration for fraud detection thresholds
CREATE TABLE fraud_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code TEXT UNIQUE NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default fraud rules
INSERT INTO fraud_rules (rule_code, description, config) VALUES
  ('rx_velocity_spike',
   'Flag when daily Rx count exceeds baseline by threshold',
   '{"baseline_days": 30, "spike_multiplier": 2.5, "min_baseline_rx": 3, "min_spike_rx": 10}'::jsonb),
  ('schedule_ii_spike',
   'Flag when Schedule II Rx share spikes vs baseline',
   '{"baseline_days": 30, "spike_multiplier": 2.0, "min_baseline_count": 5}'::jsonb),
  ('after_hours_surge',
   'Flag unusual after-hours prescribing (10pm-6am local)',
   '{"baseline_days": 30, "spike_multiplier": 3.0}'::jsonb),
  ('geographic_anomaly',
   'Flag when pharmacy distance is anomalous for prescriber',
   '{"max_normal_miles": 50, "flag_threshold_miles": 200}'::jsonb),
  ('pharmacy_clustering',
   'Flag when >N% of Rxs go to a single pharmacy (potential kickback)',
   '{"window_days": 30, "clustering_pct": 0.8, "min_rx_count": 20}'::jsonb),
  ('new_prescriber_ramp',
   'Flag unusually fast ramp-up for new prescribers',
   '{"ramp_days": 14, "max_rx_per_day": 15, "controlled_pct_threshold": 0.5}'::jsonb),
  ('patient_overlap',
   'Flag when multiple prescribers write for same patient (doctor shopping)',
   '{"window_days": 30, "min_prescribers": 3}'::jsonb),
  ('duplicate_identity',
   'Flag potential duplicate prescriber accounts',
   '{"match_fields": ["email", "npi", "dea_number"]}'::jsonb)
ON CONFLICT (rule_code) DO NOTHING;

-- RLS
ALTER TABLE getrx_prescribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE getrx_prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE osint_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE osint_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_rules ENABLE ROW LEVEL SECURITY;

-- For now: authenticated users can read/write everything
-- Tighten once roles are defined
CREATE POLICY "checker_all" ON getrx_prescribers FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "checker_all" ON getrx_prescriptions FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "checker_all" ON osint_checks FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "checker_all" ON osint_findings FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "checker_all" ON fraud_alerts FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "checker_read" ON fraud_rules FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "checker_write_rules" ON fraud_rules FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
