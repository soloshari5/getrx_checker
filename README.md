# getRx Backend Checker

Fraud/abuse detection + OSINT prescriber verification for getRx — an e-prescribing platform for controlled substances (Schedule II–V).

**Status:** pre-v1 — schema, Edge Functions, and dashboard are written but NOT yet deployed. The Supabase project referenced in earlier docs (`ztjtynjesfnccygybcen`) does not exist; the real project is `xvrlnweewzexbilozymq` ("GetRXChecker"), which currently has no getRx tables or functions deployed.

---

## What it does

### 1. OSINT Prescriber Verification
Input: `first_name, last_name, email, npi?, address?, state?, zip?`

Checks two sources, both public record only — no sensitive/private data:
- **NPPES NPI Registry** (free, no API key) — looks up `first_name + last_name + state/zip` (or `npi` directly) against the CMS national provider database. Confirms real, active license/credential, specialty, and registered practice location; flags deactivated NPIs and no-match cases.
- **Brave Search** (open web) — state is appended to the query to disambiguate common names:
  - 🚨 **Obituary / death mentions** — CRITICAL
  - 🔴 **Medical board disciplinary actions / malpractice** — HIGH
  - 🟡 **Negative news** (arrest, fraud, lawsuit) — MEDIUM
  - 🟢 **Credentials found** (MD/DO/NP/PA, NPI, license, graduation) — INFO (reduces risk score)

Returns: `risk_score 0-100`, `status`, `findings[]` with evidence URLs

### 2. Fraud Pattern Detection

| Rule | What it catches |
|------|----------------|
| **Rx velocity spike** | Prescriber jumps from e.g. 4-5 Rx/day to 10-20/day |
| **Schedule II spike** | Controlled substance prescribing surges |
| **Duplicate identity** | Same email/NPI/DEA across multiple accounts |
| **Pharmacy clustering** | >80% of Rx going to a single pharmacy (kickback indicator) |
| **Patient overlap** | Same patient getting controlled Rx from 3+ prescribers (doctor shopping) |
| **Geographic anomaly** | Rx sent to a pharmacy far from the prescriber's registered zip (public NPPES + zip-centroid distance) |
| After-hours surge | *stub — needs timezone data* |
| New prescriber ramp | *stub — needs more data* |

All thresholds are configurable in the `fraud_rules` table.

### 3. Manual Review Dashboard

`dashboard.html` — single-page app:
- Search prescriber by name/email
- Run check → see risk score, fraud alerts, OSINT findings with evidence links
- Actions: Mark Reviewed / Dismiss / Escalate
- Export report (.docx) — TODO

---

## Architecture

```
Supabase (project: xvrlnweewzexbilozymq — "GetRXChecker")
├── Tables:
│   ├── getrx_prescribers
│   ├── getrx_prescriptions
│   ├── osint_checks
│   ├── osint_findings
│   ├── fraud_alerts
│   └── fraud_rules
└── Edge Functions:
    ├── check-osint       → Brave Search → parse → store findings
    ├── check-fraud      → SQL fraud rules → store alerts
    └── check-prescriber → orchestrates both, aggregates risk score

Dashboard: dashboard.html (standalone, works from file:// or GitHub Pages)
```

Edge Functions live under `supabase/functions/<name>/index.ts` (Supabase's expected layout for `supabase functions deploy`):
- `supabase/functions/check-osint/index.ts`
- `supabase/functions/check-fraud/index.ts`
- `supabase/functions/check-prescriber/index.ts`

---

## Setup

### 1. Database

**Not yet applied.** Project `xvrlnweewzexbilozymq` ("GetRXChecker") currently has none of these tables — run both migrations against it:
```sql
-- Run supabase/migrations/20260714_getrx_checker_v1.sql
-- Then supabase/migrations/20260722_add_address_zip_npi_registry.sql
```

### 2. Edge Functions

Deploy with the Supabase CLI:
```bash
supabase functions deploy check-osint
supabase functions deploy check-fraud
supabase functions deploy check-prescriber
```

**Required secrets** (Supabase Dashboard → Edge Functions → Secrets):
```
BRAVE_API_KEY=<your_brave_search_api_key>
```

The NPPES NPI Registry and zip-centroid lookups (`npiregistry.cms.hhs.gov`, `zippopotam.us`) are free public APIs and need no key.

⚠️ **Brave Search findings will be empty until `BRAVE_API_KEY` is set in Supabase Edge Function secrets.** Get a free key at https://brave.com/search/api/ — NPI Registry verification works regardless.

### 3. Dashboard

Open `dashboard.html` in a browser, or host on GitHub Pages / any static host.

Update the `SUPABASE_ANON_KEY` constant at the top of the script with your project's anon key.

---

## API

### POST `/check-osint`
```json
{
  "first_name": "Dan",
  "last_name": "Rudd",
  "email": "dr@example.com",
  "npi": "1234567890",
  "address": "123 Main St",
  "state": "TN",
  "zip": "37167",
  "prescriber_id": "uuid-optional"
}
```
→ `{ "check_id": "...", "risk_score": 15, "status": "clean", "findings": [...] }`

### POST `/check-fraud`
```json
{ "prescriber_id": "uuid" }
```
→ `{ "risk_score": 65, "alert_count": 2, "alerts": [...] }`

### POST `/check-prescriber`
Runs both OSINT + fraud, returns combined risk score.
```json
{
  "first_name": "Dan",
  "last_name": "Rudd",
  "email": "dr@example.com",
  "address": "123 Main St",
  "state": "TN",
  "zip": "37167",
  "prescriber_id": "uuid-optional"
}
```

---

## What NPI/DEA verification is NOT in scope

NPI and DEA number verification is handled upstream by **DEALOOKUP** — the checker does NOT re-verify NPI/DEA numbers.

Free-tier OSINT does NOT include:
- DEA RDA active registration status (application submitted, waiting on approval)
- SSN Death Master File (requires NTIS certification, paid)
- State medical board real-time license status (OSINT fallback only)
- NPDB malpractice history (restricted)

These are stubbed for v2 when paid APIs / credentials are available.

---

## Fraud Detection Config

All thresholds are configurable in the `fraud_rules` table:

```sql
UPDATE fraud_rules 
SET config = '{"baseline_days": 30, "spike_multiplier": 2.5, "min_baseline_rx": 3, "min_spike_rx": 10}'::jsonb
WHERE rule_code = 'rx_velocity_spike';
```

---

## Roadmap

- [x] Reorganize Edge Functions into `supabase/functions/<name>/index.ts`
- [x] Address/zip/state intake + free public NPI Registry verification
- [x] Geographic anomaly detection (zip-centroid distance + public pharmacy NPI lookup)
- [x] Wire Mark Reviewed / Dismiss Flags to real Supabase updates
- [ ] Set `BRAVE_API_KEY` in Supabase Edge Function secrets
- [ ] Wire dashboard anon key
- [ ] Add .docx export to dashboard
- [ ] After-hours surge detection (needs prescriber timezone)
- [ ] New prescriber ramp detection
- [ ] DEA RDA integration (application pending)
- [ ] Death Master File integration
- [ ] Webhook from getRx Rails app → auto-ingest prescriptions
- [ ] Slack/Telegram alerts on high-risk flags

---

Built with Supabase + Brave Search + ❤️
