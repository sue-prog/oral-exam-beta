// ===============================
// CLOUDFLARE FUNCTION: /api/oral-exam
// Beta version — open access
// ===============================
// Environment variables to set in Cloudflare Pages dashboard:
//   OPENAI_API_KEY  — your OpenAI secret key
//   BETA_TOKEN      — lightweight guard token (must match app.js BETA_API_TOKEN)
//                     Suggested value: climb-beta-2025

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Beta-Token",
  };

  // --- Lightweight token check ---
  // Prevents accidental automated hits; not a true security gate.
  // Token is embedded in app.js and intentionally not secret.
  const token = request.headers.get("X-Beta-Token");
  if (!token || token !== env.BETA_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { prompt } = body;
  if (!prompt) {
    return new Response(JSON.stringify({ error: "Missing prompt" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // --- Call OpenAI ---
  let openAIResponse;
  try {
    openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are an FAA oral exam preparation assistant. " +
              "Always respond with valid JSON only, exactly as instructed in the user prompt. " +
              "Never include markdown, code fences, or any text outside the JSON object.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });
  } catch (err) {
    console.error("OpenAI fetch error:", err);
    return new Response(JSON.stringify({ error: "Failed to reach OpenAI" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (!openAIResponse.ok) {
    const errText = await openAIResponse.text();
    console.error("OpenAI error:", errText);
    return new Response(JSON.stringify({ error: `OpenAI error ${openAIResponse.status}` }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const openAIData = await openAIResponse.json();
  const rawContent = openAIData.choices?.[0]?.message?.content ?? "{}";

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error("Could not parse LLM response as JSON:", rawContent);
    return new Response(
      JSON.stringify({
        scenario: "The AI returned an unexpected response.",
        question: "Please click Next to try again.",
        nextAction: "askNextQuestion",
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Beta-Token",
    },
  });
}
