// ===============================
// CLOUDFLARE FUNCTION: /api/correction
// Admin writes grading corrections; grader reads them as few-shot examples.
// Uses the same BETA_CHALLENGES KV namespace with a "correction_" key prefix.
// ===============================
// GET  ?area=I           — public; returns corrections for that area (used by grader)
// POST ?token=ADMIN_TOKEN — admin stores a correction
// DELETE ?token=ADMIN_TOKEN&key=correction_... — admin removes a correction

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// GET — returns corrections for a given area (no auth required)
export async function onRequestGet(context) {
  const { request, env } = context;
  const area = new URL(request.url).searchParams.get("area");

  if (!env.BETA_CHALLENGES) {
    return new Response(JSON.stringify([]), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const list = await env.BETA_CHALLENGES.list({ prefix: "correction_" });
  const corrections = await Promise.all(
    list.keys.map(async ({ name }) => {
      const val = await env.BETA_CHALLENGES.get(name);
      return val ? { key: name, ...JSON.parse(val) } : null;
    })
  );

  const filtered = corrections
    .filter(Boolean)
    .filter(c => !area || c.areaId === area)
    .sort((a, b) => new Date(b.storedAt) - new Date(a.storedAt))
    .slice(0, 5);

  return new Response(JSON.stringify(filtered), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// POST — admin stores a correction
export async function onRequestPost(context) {
  const { request, env } = context;
  const adminToken = new URL(request.url).searchParams.get("token");

  if (!adminToken || adminToken !== env.ADMIN_TOKEN) {
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

  if (!body.areaId || !body.correctGrade || !body.adminNote) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.BETA_CHALLENGES) {
    return new Response(JSON.stringify({ error: "KV not configured" }), {
      status: 503, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const key = `correction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = { ...body, storedAt: new Date().toISOString() };

  await env.BETA_CHALLENGES.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365 * 2
  });

  return new Response(JSON.stringify({ ok: true, key }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// DELETE — admin removes a correction
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

  if (!key || !key.startsWith("correction_")) {
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
