// ===============================
// CLOUDFLARE FUNCTION: /api/stats
// Beta version — usage tracking
// ===============================
// Records events (session_start, question_answered, challenge_filed) to KV.
// Each event gets its own timestamped entry so we can do per-day/per-week counts.
//
// KV namespace binding required:
//   Variable name: BETA_STATS
//   Create in Cloudflare Pages dashboard:
//     Settings → Functions → KV namespace bindings
//
// To read stats: GET /api/stats?token=<ADMIN_TOKEN>
//
// Environment variables:
//   BETA_TOKEN    — must match app.js BETA_API_TOKEN (guards POST)
//   ADMIN_TOKEN   — separate secret for admin read access

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Beta-Token",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// POST — record an event
export async function onRequestPost(context) {
  const { request, env } = context;

  const token = request.headers.get("X-Beta-Token");
  if (!token || token !== env.BETA_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const validEvents = ["session_start", "question_answered", "challenge_filed"];
  const event = body.event;
  if (!validEvents.includes(event)) {
    return new Response(JSON.stringify({ error: "Unknown event" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.BETA_STATS) {
    console.warn("BETA_STATS KV binding not configured. Stat was not stored.");
    return new Response(JSON.stringify({ ok: true, warning: "KV not configured" }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const now = new Date();
  const key = `stat_${event}_${now.toISOString().slice(0, 10)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await env.BETA_STATS.put(key, JSON.stringify({
    event,
    timestamp: now.toISOString(),
    date: now.toISOString().slice(0, 10)
  }), {
    expirationTtl: 60 * 60 * 24 * 365 * 2  // 2 years
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// GET — aggregate and return stats (admin only)
export async function onRequestGet(context) {
  const { request, env } = context;

  const adminToken = new URL(request.url).searchParams.get("token");
  if (!adminToken || adminToken !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.BETA_STATS) {
    return new Response(JSON.stringify({ error: "KV not configured" }), {
      status: 503, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // Fetch all stat entries
  const list = await env.BETA_STATS.list({ prefix: "stat_" });
  const entries = await Promise.all(
    list.keys.map(async ({ name }) => {
      const val = await env.BETA_STATS.get(name);
      return val ? JSON.parse(val) : null;
    })
  );

  const valid = entries.filter(Boolean);

  // Aggregate totals
  const totals = { session_start: 0, question_answered: 0, challenge_filed: 0 };
  const byDate = {};

  for (const entry of valid) {
    totals[entry.event] = (totals[entry.event] || 0) + 1;

    if (!byDate[entry.date]) {
      byDate[entry.date] = { session_start: 0, question_answered: 0, challenge_filed: 0 };
    }
    byDate[entry.date][entry.event] = (byDate[entry.date][entry.event] || 0) + 1;
  }

  // Sort dates ascending
  const daily = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  return new Response(JSON.stringify({
    totals: {
      sessions: totals.session_start,
      questionsAnswered: totals.question_answered,
      challengesFiled: totals.challenge_filed
    },
    daily
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
