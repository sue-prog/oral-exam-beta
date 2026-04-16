// ===============================
// CLOUDFLARE FUNCTION: /api/challenge
// Beta version — saves grade challenges to KV
// ===============================
// Environment variables:
//   BETA_TOKEN    — must match app.js BETA_API_TOKEN (guards POST)
//   ADMIN_TOKEN   — separate secret for admin read/delete access
//
// KV namespace binding required: BETA_CHALLENGES

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Beta-Token",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// POST — student submits a challenge
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

  if (!env.BETA_CHALLENGES) {
    console.warn("BETA_CHALLENGES KV binding not configured. Challenge was not stored.");
    return new Response(JSON.stringify({ ok: true, warning: "KV not configured" }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const key = `challenge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    ...body,
    storedAt: new Date().toISOString(),
    reviewed: false
  };

  await env.BETA_CHALLENGES.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365 * 2
  });

  return new Response(JSON.stringify({ ok: true, key }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// GET — admin reads all challenges
export async function onRequestGet(context) {
  const { request, env } = context;

  const adminToken = new URL(request.url).searchParams.get("token");
  if (!adminToken || adminToken !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.BETA_CHALLENGES) {
    return new Response(JSON.stringify({ error: "KV not configured" }), {
      status: 503, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const list = await env.BETA_CHALLENGES.list({ prefix: "challenge_" });
  const challenges = await Promise.all(
    list.keys.map(async ({ name }) => {
      const val = await env.BETA_CHALLENGES.get(name);
      return val ? { key: name, ...JSON.parse(val) } : null;
    })
  );

  const filtered = challenges.filter(Boolean).sort((a, b) =>
    new Date(b.storedAt) - new Date(a.storedAt)
  );

  return new Response(JSON.stringify(filtered), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// DELETE — admin removes a resolved challenge
export async function onRequestDelete(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const adminToken = url.searchParams.get("token");
  const key = url.searchParams.get("key");

  if (!adminToken || adminToken !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!key || !key.startsWith("challenge_")) {
    return new Response(JSON.stringify({ error: "Invalid key" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.BETA_CHALLENGES) {
    return new Response(JSON.stringify({ error: "KV not configured" }), {
      status: 503, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  await env.BETA_CHALLENGES.delete(key);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
