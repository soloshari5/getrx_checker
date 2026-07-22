# getRx Backend Checker — Design Doc

> Fraud/abuse detection + prescriber OSINT verification
> GitHub + Supabase | Free tier v1 | Manual review dashboard

---

## Scope

**IN scope:**
- Fraud pattern detection (Rx velocity spikes, geographic anomalies, duplicate identities, etc.)
- Prescriber OSINT lookup — first_name + last_name + email → web search → credential/graduation/death/obituary/news flags
- Manual review dashboard — Shari inputs a name/email, gets a risk report
- Audit trail of all checks

**OUT of scope (already covered):**
- NPI verification → DEALOOKUP ✅
- DEA number verification → DEALOOKUP ✅

**Deferred to v2 (when paid APIs / credentials available):**
- DEA RDA active registration check — application submitted, waiting on approval
- SSN Death Master File — use OSINT obituary search for v1
- State medical board real-time license status — OSINT fallback for v1
- NPDB malpractice history — restricted

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  getRx Checker                                          │
│  Supabase (ztjtynjesfnccygybcen) + GitHub              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Edge Functions:                                        │
│  ┌──────────────────┐  ┌──────────────────────────┐    │
│  │ /check-osint     │  │ /check-fraud             │    │
│  │                  │  │                          │    │
│  │ Input: first,    │  │ Input: prescriber_id     │    │
│  │   last, email,   │  │                          │    │
│  │   npi?           │  │ Checks:                  │    │
│  │                  │  │ • Rx velocity spike      │    │
│  │ 1. Brave Search  │  │ • Geographic anomaly     │    │
│  │    name+email    │  │ • Duplicate identity     │    │
│  │ 2. Parse results │  │ • Schedule II spike      │    │
│  │    for flags:    │  │ • After-hours surge      │    │
│  │  • obituary/     │  │ • Pharmacy clustering    │    │
│  │    death mention │  │ • Patient overlap        │    │
│  │  • medical       │  │ • New prescriber ramp    │    │
│  │    credentials   │  │                          │    │
│  │  • graduation /  │  │ Output: risk_score,      │    │
│  │    residency     │  │   flags[]                │    │
│  │  • license /     │  │                          │    │
│  │    NPI mentions  │  │                          │    │
│  │  • malpractice / │  └──────────────────────────┘    │
│  │    news /        │                                   │
│  │    board action  │  ┌──────────────────────────┐    │
│  │                  │  │ /check-prescriber        │    │
│  │ Output:          │  │ (orchestrator)           │    │
│  │   findings[],    │  │                          │    │
│  │   risk_signals[] │  │ Runs OSINT + fraud      │    │
│  │                  │  │ checks, aggregates       │    │
│  └──────────────────┘  │ risk score               │    │
│                        └──────────────────────────┘    │
│                                                         │
│  Dashboard:                                             │
│  ┌─────────────────────────────────────────────┐      │
│  │  Manual Review UI (simple HTML/JS)            │      │
│  │  • Search prescriber by name/email            │      │
│  │  • Run OSINT check → see findings            │      │
│  │  • View fraud alerts                         │      │
│  │  • Mark flags as reviewed/dismissed           │      │
│  │  • Export report (.docx)                     │      │
│  └─────────────────────────────────────────────┘      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Database Schema

```sql
-- Prescribers (synced from getRx Rails app, or standalone)
CREATE TABLE getrx_prescribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  npi TEXT,
  dea_number TEXT,
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
  checked_at TIMESTAMPTZ DEFAULT now(),
  checked_by UUID REFERENCES auth.users(id),
  risk_score INTEGER DEFAULT 0, -- 0-100
  status TEXT DEFAULT 'pending', -- pending, clean, flagged, reviewed
  raw_results JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE osint_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID REFERENCES osint_checks(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL,
  -- finding_type: 'obituary', 'death_mention', 'credential_found',
  --   'graduation', 'license_mention', 'npi_mention',
  --   'malpractice', 'board_action', 'news_negative',
  --   'social_profile', 'no_results'
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
```

---

## Fraud Detection Rules

### 1. Rx Velocity Spike
> "someone just started writing 10-20 prescriptions a day when they used to do 4 or 5"

```
baseline = avg daily Rx over last 30 days
current  = Rx count in last 24h / 7d window

ALERT IF:
  baseline >= 3 AND
  current >= baseline * 2.5 AND
  current >= 10

Severity: HIGH if 3x+ baseline, MEDIUM if 2.5x+
```

### 2. Schedule II Spike
Same logic, but for Schedule II controlled substances specifically.

### 3. After-Hours Surge
```
baseline = % of Rx written 10pm–6am (30-day)
current  = % of Rx in last 7 days, 10pm–6am

ALERT IF: current_pct >= baseline_pct * 3.0
```

### 4. Geographic Anomaly
Flag Rx sent to pharmacies >200 miles from prescriber's registered address (configurable).

### 5. Pharmacy Clustering
```
IF >80% of Rx in 30-day window go to a SINGLE pharmacy
AND total Rx >= 20
→ Flag (potential kickback / pill mill indicator)
```

### 6. New Prescriber Ramp
```
IF prescriber_age < 14 days
AND avg_rx_per_day > 15
AND controlled_pct > 50%
→ Flag
```

### 7. Patient Overlap (Doctor Shopping)
```
IF same patient_hash appears with >=3 distinct prescribers
within 30-day window
→ Flag all involved prescribers
```

### 8. Duplicate Identity
Exact match on email, NPI, or DEA number across multiple prescriber accounts.

---

## OSINT Checker

Input: `first_name, last_name, email, npi?`

Search queries (Brave Search API):
1. `"First Last" "MD" OR "DO" OR "NP" OR "PA" site:npi-registry OR site:healthgrades OR site:vitals`
2. `"First Last" obituary OR died OR deceased`
3. `"First Last" medical board OR license OR disciplinary`
4. `"First Last" malpractice OR lawsuit`
5. `email` (exact match, quoted)
6. If NPI provided: `"NPI_NUMBER"` direct lookup

Parse results for:
- 🚨 **CRITICAL**: obituary / death notice found
- 🔴 **HIGH**: medical board disciplinary action, malpractice news
- 🟡 **MEDIUM**: license mentions that don't match claimed state/specialty
- 🟢 **INFO**: credential found (graduation, residency, NPI profile, Healthgrades, etc.)
- ⚪ **INFO**: social profiles found (LinkedIn, Doximity)

Risk score = weighted sum of findings.

---

## API Endpoints (Supabase Edge Functions)

### POST `/check-osint`
```json
{
  "first_name": "Dan",
  "last_name": "Rudd",
  "email": "dr@example.com",
  "npi": "1234567890"
}
→ {
  "risk_score": 15,
  "status": "clean",
  "findings": [
    {"type": "credential_found", "severity": "info",
     "title": "Dan Rudd, MD - Internal Medicine - Smyrna, TN",
     "url": "https://...",
     "confidence": 0.9}
  ]
}
```

### POST `/check-fraud`
```json
{"prescriber_id": "uuid"}
→ {
  "risk_score": 65,
  "alerts": [
    {"type": "rx_velocity_spike", "severity": "high",
     "details": {"baseline": 4.2, "current": 18, "multiplier": 4.3}}
  ]
}
```

### POST `/check-prescriber`
Runs both OSINT + fraud, aggregates risk score.

---

## Manual Review Dashboard

Simple HTML/JS page (hosted on Supabase / GitHub Pages):
- Search prescriber by name/email
- "Run Check" button → calls `/check-prescriber`
- Results panel: risk score, flags, evidence with links
- Actions: Mark as Reviewed / Dismiss / Escalate
- Export report → .docx

---

## Build Plan

1. ✅ Database schema (Supabase)
2. OSINT checker Edge Function (Brave Search → parse → store)
3. Fraud detection Edge Function (SQL-based rules against getrx_prescriptions)
4. Orchestrator Edge Function (`/check-prescriber`)
5. Manual review dashboard (HTML/JS)
6. GitHub repo setup + CI
7. Seed with test data + tune thresholds

All free tier: Supabase (free), Brave Search (free tier), GitHub (free).

DEA RDA hook: leave a stub in the OSINT checker — when approval comes through, drop in the API call, no schema changes needed.

---

## Open Questions

- Where should prescription data come from? Direct DB sync from Rails? CSV import? API webhook from getRx?
- For the manual review dashboard — do you want it as a standalone page (GitHub Pages), or integrated into the existing getRx web portal?
- Any specific fraud patterns beyond the 8 listed that you've seen / are worried about?
- Export format for fraud reports — .docx like the ComplianceIQ gap analysis, or CSV/JSON is fine?
