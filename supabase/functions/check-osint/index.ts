import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRAVE_API_KEY = Deno.env.get("BRAVE_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface OsintRequest {
  first_name: string;
  last_name: string;
  email?: string;
  npi?: string;
  address?: string;
  zip?: string;
  state?: string;
  prescriber_id?: string;
}

interface Finding {
  finding_type: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  url: string;
  snippet: string;
  confidence: number;
}

async function braveSearch(query: string): Promise<any> {
  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, {
    headers: { "X-Subscription-Token": BRAVE_API_KEY, "Accept": "application/json" },
  });
  if (!resp.ok) return { web: { results: [] } };
  return await resp.json();
}

// NPPES NPI Registry — public, free, no API key. https://npiregistry.cms.hhs.gov/api-page
async function npiRegistryLookup(firstName: string, lastName: string, state?: string, zip?: string, npi?: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const params = new URLSearchParams({ version: "2.1", limit: "5" });
  if (npi) {
    params.set("number", npi);
  } else {
    params.set("first_name", firstName);
    params.set("last_name", lastName);
    if (state) params.set("state", state);
    if (zip) params.set("postal_code", zip);
  }

  let data: any;
  try {
    const resp = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
    if (!resp.ok) return findings;
    data = await resp.json();
  } catch {
    return findings;
  }

  const results = data?.results || [];

  if (results.length === 0) {
    findings.push({
      finding_type: "npi_registry_no_match",
      severity: "medium",
      title: `No NPI Registry record found for ${firstName} ${lastName}${state ? ` in ${state}` : ""}`,
      url: "https://npiregistry.cms.hhs.gov/search",
      snippet: "No matching provider in the CMS National Plan & Provider Enumeration System (public record). May indicate a name/location mismatch or a non-physician prescriber type — not conclusive on its own.",
      confidence: 0.3,
    });
    return findings;
  }

  for (const r of results) {
    const basic = r.basic || {};
    const taxonomy = (r.taxonomies || []).find((t: any) => t.primary) || (r.taxonomies || [])[0] || {};
    const address = (r.addresses || []).find((a: any) => a.address_purpose === "LOCATION") || (r.addresses || [])[0] || {};
    const providerUrl = `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`;

    if (basic.deactivation_date) {
      findings.push({
        finding_type: "npi_registry_inactive",
        severity: "high",
        title: `NPI ${r.number} deactivated (${basic.deactivation_date})`,
        url: providerUrl,
        snippet: `${basic.first_name} ${basic.last_name}, ${basic.credential || ""} — ${basic.deactivation_reason_code || "reason not specified"}.`,
        confidence: 0.85,
      });
      continue;
    }

    findings.push({
      finding_type: "npi_registry_match",
      severity: "info",
      title: `Verified in NPI Registry: ${basic.first_name} ${basic.last_name}, ${basic.credential || ""} — NPI ${r.number}`,
      url: providerUrl,
      snippet: [
        taxonomy.desc ? `Specialty: ${taxonomy.desc}` : null,
        taxonomy.license ? `License: ${taxonomy.license}${taxonomy.state ? ` (${taxonomy.state})` : ""}` : null,
        address.state ? `Practice location: ${address.city || ""}, ${address.state} ${address.postal_code || ""}` : null,
      ].filter(Boolean).join(" · "),
      confidence: 0.9,
    });
  }

  return findings;
}

function analyzeResults(results: any[], query: string, firstName: string, lastName: string): Finding[] {
  const findings: Finding[] = [];
  const fullName = `${firstName} ${lastName}`.toLowerCase();
  const fullNameRe = new RegExp(`${firstName}\\s+${lastName}`, "i");

  for (const r of results) {
    const title = (r.title || "").toLowerCase();
    const desc = (r.description || "").toLowerCase();
    const url = r.url || "";
    const text = title + " " + desc;

    // Death / obituary — CRITICAL
    if (/\b(obituary|died|deceased|passed away|death|memorial|funeral)\b/.test(text)) {
      if (fullNameRe.test(text)) {
        findings.push({
          finding_type: "obituary",
          severity: "critical",
          title: r.title || "Obituary / death mention",
          url,
          snippet: r.description || "",
          confidence: 0.7,
        });
        continue;
      }
    }

    // Medical board / disciplinary — HIGH
    if (/\b(board|disciplinary|sanction|revoked|suspended|probation|malpractice|complaint)\b/.test(text)) {
      if (fullNameRe.test(text)) {
        findings.push({
          finding_type: /malpractice/.test(text) ? "malpractice" : "board_action",
          severity: "high",
          title: r.title || "Board action / malpractice mention",
          url,
          snippet: r.description || "",
          confidence: 0.6,
        });
        continue;
      }
    }

    // Medical credentials — INFO (good signal)
    if (/\b(md|do|np|pa|dpm|dds|dmd|pharmd|npi|dea|licensed|board certified|residency)\b/.test(text)) {
      if (fullNameRe.test(text)) {
        findings.push({
          finding_type: "credential_found",
          severity: "info",
          title: r.title || "Medical credential found",
          url,
          snippet: r.description || "",
          confidence: 0.5,
        });
        continue;
      }
    }

    // NPI mention
    if (/\bnpi\b|\b\d{10}\b/.test(text) && fullNameRe.test(text)) {
      findings.push({
        finding_type: "npi_mention",
        severity: "info",
        title: r.title || "NPI mention found",
        url,
        snippet: r.description || "",
        confidence: 0.5,
      });
      continue;
    }

    // Graduation / education
    if (/\b(graduated|graduation|class of|alumni|residency|fellowship|school of medicine)\b/.test(text)) {
      if (fullNameRe.test(text)) {
        findings.push({
          finding_type: "graduation",
          severity: "info",
          title: r.title || "Education / graduation mention",
          url,
          snippet: r.description || "",
          confidence: 0.4,
        });
        continue;
      }
    }

    // News / negative press
    if (/\b(arrest|fraud|lawsuit|indicted|convicted|settlement|investigation)\b/.test(text)) {
      if (fullNameRe.test(text)) {
        findings.push({
          finding_type: "news_negative",
          severity: "medium",
          title: r.title || "Negative news mention",
          url,
          snippet: r.description || "",
          confidence: 0.5,
        });
      }
    }
  }

  return findings;
}

function riskScore(findings: Finding[]): number {
  let score = 0;
  for (const f of findings) {
    const mult = f.confidence || 0.5;
    if (f.severity === "critical") score += 100 * mult;
    else if (f.severity === "high") score += 40 * mult;
    else if (f.severity === "medium") score += 15 * mult;
    else if (f.severity === "low") score += 5 * mult;
  }
  // Public-record verification reduces risk: a real, active NPI registry match
  // is stronger evidence than an incidental web-search credential mention.
  const npiMatchCount = findings.filter(f => f.finding_type === "npi_registry_match").length;
  const credCount = findings.filter(f => f.finding_type === "credential_found").length;
  score = Math.max(0, score - npiMatchCount * 15 - credCount * 5);
  return Math.min(100, Math.round(score));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { first_name, last_name, email, npi, address, zip, state, prescriber_id } = await req.json() as OsintRequest;

    if (!first_name || !last_name) {
      return new Response(JSON.stringify({ error: "first_name and last_name required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Build search queries — include state when known, to disambiguate common names
    const locationHint = state ? ` ${state}` : "";
    const queries = [
      `"${first_name} ${last_name}"${locationHint} MD OR DO OR NP OR PA`,
      `"${first_name} ${last_name}"${locationHint} obituary OR died OR deceased`,
      `"${first_name} ${last_name}"${locationHint} "medical board" OR license OR disciplinary`,
    ];
    if (email) queries.push(`"${email}"`);
    if (npi) queries.push(`"${npi}"`);

    // Run web searches + public NPI registry lookup in parallel
    const [searchResults, npiFindings] = await Promise.all([
      Promise.all(queries.map(q => braveSearch(q))),
      npiRegistryLookup(first_name, last_name, state, zip, npi),
    ]);

    const allResults: any[] = [];
    const seen = new Set<string>();
    for (const sr of searchResults) {
      for (const r of sr.web?.results || []) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url);
          allResults.push(r);
        }
      }
    }

    // Analyze
    const findings = [...npiFindings, ...analyzeResults(allResults, queries[0], first_name, last_name)];
    const score = riskScore(findings);

    let status = "clean";
    if (findings.some(f => f.severity === "critical")) status = "flagged";
    else if (findings.some(f => f.severity === "high")) status = "flagged";
    else if (findings.some(f => f.severity === "medium")) status = "flagged";
    else if (findings.length === 0) status = "no_results";

    // Store check in DB
    const dbResp = await fetch(`${SUPABASE_URL}/rest/v1/osint_checks`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        prescriber_id: prescriber_id || null,
        first_name, last_name, email: email || null, npi: npi || null,
        address: address || null, zip: zip || null, state: state || null,
        risk_score: score,
        status,
        raw_results: { queries, result_count: allResults.length },
      }),
    });
    const checkRows = await dbResp.json();
    const check_id = checkRows?.[0]?.id;

    // Store findings
    if (check_id && findings.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/osint_findings`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(findings.map(f => ({ check_id, ...f }))),
      });
    }

    return new Response(JSON.stringify({
      check_id,
      risk_score: score,
      status,
      findings,
      result_count: allResults.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
