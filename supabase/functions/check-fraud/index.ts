import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function pg(table: string, select = "*", filter = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}${filter ? `&${filter}` : ""}`;
  const resp = await fetch(url, {
    headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  return await resp.json();
}

// Public, free, no-key services used for the geographic anomaly rule:
// - zippopotam.us: zip code -> lat/lng centroid
// - NPPES NPI Registry: pharmacy (organizational) NPI -> practice address/zip
const zipCache = new Map<string, { lat: number; lng: number } | null>();
async function zipToLatLng(zip: string): Promise<{ lat: number; lng: number } | null> {
  const clean = (zip || "").trim().slice(0, 5);
  if (!clean) return null;
  if (zipCache.has(clean)) return zipCache.get(clean)!;
  try {
    const resp = await fetch(`https://api.zippopotam.us/us/${clean}`);
    if (!resp.ok) { zipCache.set(clean, null); return null; }
    const data = await resp.json();
    const place = data?.places?.[0];
    const result = place ? { lat: parseFloat(place.latitude), lng: parseFloat(place.longitude) } : null;
    zipCache.set(clean, result);
    return result;
  } catch {
    zipCache.set(clean, null);
    return null;
  }
}

const pharmacyZipCache = new Map<string, string | null>();
async function pharmacyNpiToZip(npi: string): Promise<string | null> {
  if (pharmacyZipCache.has(npi)) return pharmacyZipCache.get(npi)!;
  try {
    const resp = await fetch(`https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`);
    if (!resp.ok) { pharmacyZipCache.set(npi, null); return null; }
    const data = await resp.json();
    const address = (data?.results?.[0]?.addresses || []).find((a: any) => a.address_purpose === "LOCATION") || data?.results?.[0]?.addresses?.[0];
    const zip = address?.postal_code ? String(address.postal_code).slice(0, 5) : null;
    pharmacyZipCache.set(npi, zip);
    return zip;
  } catch {
    pharmacyZipCache.set(npi, null);
    return null;
  }
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { prescriber_id } = await req.json();
    if (!prescriber_id) return new Response(JSON.stringify({ error: "prescriber_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const alerts: any[] = [];
    async function createAlert(alert_type: string, severity: string, details: any) {
      await fetch(`${SUPABASE_URL}/rest/v1/fraud_alerts`, {
        method: "POST",
        headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ prescriber_id, alert_type, severity, details }),
      });
    }

    const rules = await pg("fraud_rules", "*", "enabled=eq.true");
    const ruleMap: Record<string, any> = {};
    for (const r of rules) ruleMap[r.rule_code] = r.config;

    const prescriber = (await pg("getrx_prescribers", "*", `id=eq.${prescriber_id}`))[0];

    // RULE 1: Rx Velocity Spike
    const vCfg = ruleMap["rx_velocity_spike"] || { baseline_days: 30, spike_multiplier: 2.5, min_baseline_rx: 3, min_spike_rx: 10 };
    {
      const baselineDays = vCfg.baseline_days || 30;
      const baselineRows = await pg("getrx_prescriptions", "prescribed_at", `prescriber_id=eq.${prescriber_id}&prescribed_at=gte.${new Date(Date.now() - baselineDays * 86400000).toISOString()}&prescribed_at=lt.${new Date(Date.now() - 86400000).toISOString()}`);
      const baselineDaily = baselineRows.length / baselineDays;
      const recentRows = await pg("getrx_prescriptions", "prescribed_at", `prescriber_id=eq.${prescriber_id}&prescribed_at=gte.${new Date(Date.now() - 86400000).toISOString()}`);
      const currentDaily = recentRows.length;
      const multiplier = baselineDaily > 0 ? currentDaily / baselineDaily : 0;
      const isSpike = baselineDaily >= (vCfg.min_baseline_rx || 3) && currentDaily >= (vCfg.min_spike_rx || 10) && multiplier >= (vCfg.spike_multiplier || 2.5);
      if (isSpike) {
        const severity = multiplier >= 4 ? "critical" : multiplier >= 3 ? "high" : "medium";
        await createAlert("rx_velocity_spike", severity, { baseline_daily: Math.round(baselineDaily * 10) / 10, current_daily: currentDaily, multiplier: Math.round(multiplier * 10) / 10 });
        alerts.push({ alert_type: "rx_velocity_spike", severity, details: { baseline_daily: Math.round(baselineDaily * 10) / 10, current_daily: currentDaily, multiplier: Math.round(multiplier * 10) / 10 } });
      }
    }

    // RULE 2: Schedule II Spike
    const s2Cfg = ruleMap["schedule_ii_spike"] || { baseline_days: 30, spike_multiplier: 2.0, min_baseline_count: 5 };
    {
      const days = s2Cfg.baseline_days || 30;
      const baselineRows = await pg("getrx_prescriptions", "drug_schedule", `prescriber_id=eq.${prescriber_id}&drug_schedule=eq.II&prescribed_at=gte.${new Date(Date.now() - days * 86400000).toISOString()}&prescribed_at=lt.${new Date(Date.now() - 86400000).toISOString()}`);
      const recentRows = await pg("getrx_prescriptions", "drug_schedule", `prescriber_id=eq.${prescriber_id}&drug_schedule=eq.II&prescribed_at=gte.${new Date(Date.now() - 86400000).toISOString()}`);
      const isSpike = baselineRows.length >= (s2Cfg.min_baseline_count || 5) && recentRows.length >= (baselineRows.length / days) * (s2Cfg.spike_multiplier || 2.0) && recentRows.length > 0;
      if (isSpike) {
        await createAlert("schedule_ii_spike", "high", { baseline_count: baselineRows.length, current_count: recentRows.length });
        alerts.push({ alert_type: "schedule_ii_spike", severity: "high", details: { baseline_count: baselineRows.length, current_count: recentRows.length } });
      }
    }

    // RULE 3: Duplicate Identity
    {
      if (prescriber) {
        const dupes: any[] = [];
        if (prescriber.email) {
          const sameEmail = await pg("getrx_prescribers", "id,email", `email=eq.${encodeURIComponent(prescriber.email)}&id=neq.${prescriber_id}`);
          dupes.push(...sameEmail.map((d: any) => ({ field: "email", match_id: d.id })));
        }
        if (prescriber.npi) {
          const sameNpi = await pg("getrx_prescribers", "id,npi", `npi=eq.${prescriber.npi}&id=neq.${prescriber_id}`);
          dupes.push(...sameNpi.map((d: any) => ({ field: "npi", match_id: d.id })));
        }
        if (prescriber.dea_number) {
          const sameDea = await pg("getrx_prescribers", "id,dea_number", `dea_number=eq.${prescriber.dea_number}&id=neq.${prescriber_id}`);
          dupes.push(...sameDea.map((d: any) => ({ field: "dea_number", match_id: d.id })));
        }
        if (dupes.length > 0) {
          await createAlert("duplicate_identity", "critical", { duplicates: dupes });
          alerts.push({ alert_type: "duplicate_identity", severity: "critical", details: { duplicates: dupes } });
        }
      }
    }

    // RULE 4: Pharmacy Clustering
    const pcCfg = ruleMap["pharmacy_clustering"] || { window_days: 30, clustering_pct: 0.8, min_rx_count: 20 };
    {
      const windowDays = pcCfg.window_days || 30;
      const rxRows = await pg("getrx_prescriptions", "pharmacy_npi", `prescriber_id=eq.${prescriber_id}&prescribed_at=gte.${new Date(Date.now() - windowDays * 86400000).toISOString()}`);
      if (rxRows.length >= (pcCfg.min_rx_count || 20)) {
        const counts: Record<string, number> = {};
        for (const r of rxRows) { const npi = r.pharmacy_npi || "unknown"; counts[npi] = (counts[npi] || 0) + 1; }
        const maxCount = Math.max(...Object.values(counts));
        const pct = maxCount / rxRows.length;
        if (pct >= (pcCfg.clustering_pct || 0.8)) {
          const topPharmacy = Object.entries(counts).find(([_, c]) => c === maxCount)?.[0];
          await createAlert("pharmacy_clustering", "medium", { top_pharmacy_npi: topPharmacy, top_pharmacy_count: maxCount, total_rx: rxRows.length, clustering_pct: Math.round(pct * 100) / 100 });
          alerts.push({ alert_type: "pharmacy_clustering", severity: "medium", details: { top_pharmacy_npi: topPharmacy, clustering_pct: Math.round(pct * 100) / 100 } });
        }
      }
    }

    // RULE 5: Patient Overlap (Doctor Shopping)
    const poCfg = ruleMap["patient_overlap"] || { window_days: 30, min_prescribers: 3 };
    {
      const windowDays = poCfg.window_days || 30;
      const rxRows = await pg("getrx_prescriptions", "patient_hash", `prescriber_id=eq.${prescriber_id}&prescribed_at=gte.${new Date(Date.now() - windowDays * 86400000).toISOString()}`);
      const patientHashes = [...new Set(rxRows.map((r: any) => r.patient_hash).filter(Boolean))];
      const overlapping: any[] = [];
      for (const ph of patientHashes.slice(0, 50)) {
        const otherRx = await pg("getrx_prescriptions", "prescriber_id", `patient_hash=eq.${encodeURIComponent(ph)}&prescribed_at=gte.${new Date(Date.now() - windowDays * 86400000).toISOString()}`);
        const uniquePrescribers = [...new Set(otherRx.map((r: any) => r.prescriber_id))];
        if (uniquePrescribers.length >= (poCfg.min_prescribers || 3)) {
          overlapping.push({ patient_hash: ph, prescriber_count: uniquePrescribers.length });
        }
      }
      if (overlapping.length > 0) {
        await createAlert("patient_overlap", "high", { overlapping_patients: overlapping, window_days: windowDays });
        alerts.push({ alert_type: "patient_overlap", severity: "high", details: { patient_count: overlapping.length } });
      }
    }

    // RULE 6: Geographic Anomaly
    // Uses only public-record data: the prescriber's own registered zip, and each
    // pharmacy's public NPPES practice address (looked up by pharmacy NPI). No
    // patient data or private records involved.
    const geoCfg = ruleMap["geographic_anomaly"] || { max_normal_miles: 50, flag_threshold_miles: 200 };
    {
      if (prescriber?.zip) {
        const prescriberLoc = await zipToLatLng(prescriber.zip);
        if (prescriberLoc) {
          const windowDays = 30;
          const rxRows = await pg("getrx_prescriptions", "pharmacy_npi", `prescriber_id=eq.${prescriber_id}&prescribed_at=gte.${new Date(Date.now() - windowDays * 86400000).toISOString()}`);
          const pharmacyNpis = [...new Set(rxRows.map((r: any) => r.pharmacy_npi).filter(Boolean))].slice(0, 25);

          const farPharmacies: any[] = [];
          for (const pNpi of pharmacyNpis) {
            const pharmacyZip = await pharmacyNpiToZip(pNpi);
            if (!pharmacyZip) continue;
            const pharmacyLoc = await zipToLatLng(pharmacyZip);
            if (!pharmacyLoc) continue;
            const miles = Math.round(haversineMiles(prescriberLoc, pharmacyLoc));
            if (miles >= (geoCfg.flag_threshold_miles || 200)) {
              farPharmacies.push({ pharmacy_npi: pNpi, pharmacy_zip: pharmacyZip, distance_miles: miles });
            }
          }

          if (farPharmacies.length > 0) {
            const maxDistance = Math.max(...farPharmacies.map(f => f.distance_miles));
            const severity = maxDistance >= (geoCfg.flag_threshold_miles || 200) * 2 ? "high" : "medium";
            await createAlert("geographic_anomaly", severity, { prescriber_zip: prescriber.zip, far_pharmacies: farPharmacies });
            alerts.push({ alert_type: "geographic_anomaly", severity, details: { prescriber_zip: prescriber.zip, far_pharmacy_count: farPharmacies.length, max_distance_miles: maxDistance } });
          }
        }
      }
    }

    const risk_score = alerts.reduce((sum, a) =>
      sum + (a.severity === "critical" ? 40 : a.severity === "high" ? 25 : a.severity === "medium" ? 10 : 3), 0);

    return new Response(JSON.stringify({
      prescriber_id,
      risk_score: Math.min(100, risk_score),
      alert_count: alerts.length,
      alerts,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), stack: (e as any)?.stack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
