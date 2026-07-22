import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { first_name, last_name, email, npi, address, zip, state, prescriber_id } = body;
    if (!first_name || !last_name) {
      return new Response(JSON.stringify({ error: "first_name and last_name required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const osintResp = await fetch(`${SUPABASE_URL}/functions/v1/check-osint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify({ first_name, last_name, email, npi, address, zip, state, prescriber_id }),
    });
    const osint = await osintResp.json();

    let fraud = { risk_score: 0, alert_count: 0, alerts: [] };
    if (prescriber_id && osint.check_id) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/osint_checks?id=eq.${osint.check_id}`, {
          method: "PATCH",
          headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({ prescriber_id }),
        });
      } catch {}
      const fraudResp = await fetch(`${SUPABASE_URL}/functions/v1/check-fraud`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}`, "apikey": SUPABASE_ANON_KEY },
        body: JSON.stringify({ prescriber_id }),
      });
      if (fraudResp.ok) fraud = await fraudResp.json();
    }

    const combined_risk = Math.min(100, (osint.risk_score || 0) + (fraud.risk_score || 0));
    let status = "clean";
    if (combined_risk >= 70) status = "block";
    else if (combined_risk >= 30) status = "review";
    else if (combined_risk > 0) status = "low_risk";

    return new Response(JSON.stringify({
      prescriber: { first_name, last_name, email, npi, address, zip, state },
      prescriber_id,
      osint_check_id: osint.check_id,
      risk_score: combined_risk,
      status,
      osint: { risk_score: osint.risk_score || 0, status: osint.status, findings: osint.findings || [] },
      fraud: { risk_score: fraud.risk_score || 0, alert_count: fraud.alert_count || 0, alerts: fraud.alerts || [] },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
