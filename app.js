// ===============================
// ORAL EXAM PREP — BETA VERSION
// Climb LLC
// ===============================
// This is the standalone beta build used to collect grade challenges
// and usage stats to improve AI grading accuracy over time.
//
// Key differences from the main app:
//   - No user token required (open access)
//   - Welcome/beta instructions screen on load
//   - Challenge Grade posts to Cloudflare KV for admin review
//   - Usage stats (sessions started, questions answered) tracked in KV
//   - No flag button (simplified to challenge-only feedback)
//   - Private Pilot ASEL only, all areas
// ===============================

// Internal API token — sent with every API request.
// This is intentionally not secret; it's a lightweight guard against
// accidental automated hits, not a security mechanism.
// Match this to the BETA_TOKEN environment variable in Cloudflare.
const BETA_API_TOKEN = "climb-beta-2025";

// --- Global state ---
let config = null;
let localTextCache = "";
let currentAreaIndex = 0;
let currentTaskIndex = 0;
let depthMode = "normal";
let sessionPerformance = {};
let isAdaptiveMode = false;
let currentLLMData = null;
let currentEvalPrompt = "";  // saved for challenge submissions

const RECENT_QUESTION_MEMORY = 5;
let recentQuestionsByArea = {};

const FULL_EXAM_BASE_QUESTIONS = 3;
const FULL_EXAM_EXTENSION_QUESTIONS = 0;

function areaPassThreshold(total) {
  return total * 0.8;
}

let fullExamAreaQuestionCount = 0;
let fullExamAreaResults = {};
let fullExamExtensionAvailable = new Set();
let currentAreaInExtension = false;

let activeVariant = "";
let currentAreaTasks = [];

function buildAreaTaskList(area, variant, isExtensionRound) {
  if (!area.tasks || area.tasks.length === 0) return [];
  if (!variant) return area.tasks;
  return area.tasks.filter(task => {
    if (!task.variants) return true;
    const v = task.variants[variant];
    if (!v) return false;
    if (!isExtensionRound) return v === "required";
    return true;
  });
}

function hasApplicableTasks(area, variant) {
  return buildAreaTaskList(area, variant, false).length > 0 ||
         buildAreaTaskList(area, variant, true).length > 0;
}

// ===============================
// 1. INITIALIZATION
// ===============================

async function init() {
  const params = new URLSearchParams(window.location.search);

  // No token check — this app is open access.
  // The welcome screen is always shown first; user clicks to start.

  depthMode = params.get("depth") || "normal";
  activeVariant = (params.get("variant") || "").replace(/[^a-z0-9_-]/gi, "");

  // Show welcome screen (user must click Start to begin)
  showScreen("welcome");

  document.getElementById("start-btn").addEventListener("click", async () => {
    showScreen("loading");
    await startSession(params);
  });
}

async function startSession(params) {
  try {
    // Always use private_asel — this beta is private pilot only
    config = await loadJSON("configs/private_asel.json");
    localTextCache = await loadLocalText(config.localText);
    loadPerformance();

    // Start area from URL param or beginning
    const startAreaId = params.get("area") || null;
    if (startAreaId) {
      const idx = config.areasOfOperation.findIndex(a => a.id === startAreaId.toUpperCase());
      if (idx !== -1) currentAreaIndex = idx;
    }

    // Skip areas with no applicable tasks
    while (
      currentAreaIndex < config.areasOfOperation.length &&
      !hasApplicableTasks(config.areasOfOperation[currentAreaIndex], activeVariant)
    ) {
      currentAreaIndex++;
    }

    currentAreaTasks = buildAreaTaskList(
      config.areasOfOperation[currentAreaIndex],
      activeVariant,
      false
    );

    showScreen("exam");
    updateProgressUI();
    await askNextQuestion();

    // Ping stats: session started (fire-and-forget, ignore errors)
    pingStats("session_start").catch(() => {});

  } catch (err) {
    console.error("Init error:", err);
    showError("Could not load the exam session. Please try refreshing the page.");
  }
}

// ===============================
// 2. SCREEN MANAGEMENT
// ===============================

function showScreen(id) {
  const screens = ["loading", "welcome", "exam", "complete", "error-screen", "single-area-complete"];
  screens.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle("hidden", s !== id);
  });
}

function showError(message) {
  document.getElementById("error-message").textContent = message;
  showScreen("error-screen");
}

// ===============================
// 3. LOADERS
// ===============================

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return await res.json();
}

async function loadLocalText(paths) {
  if (!paths || paths.length === 0) return "";
  let combined = "";
  for (const p of paths) {
    try {
      const res = await fetch(p);
      const text = await res.text();
      combined += `\n\n=== LOCAL TEXT: ${p} ===\n${text}`;
    } catch {
      console.warn("Could not load local text:", p);
    }
  }
  return combined;
}

// ===============================
// 4. PERFORMANCE STORAGE
// ===============================

function loadPerformance() {
  const saved = sessionStorage.getItem("betaExamPerformance");
  sessionPerformance = saved ? JSON.parse(saved) : {};
}

function savePerformance() {
  sessionStorage.setItem("betaExamPerformance", JSON.stringify(sessionPerformance));
}

function recordPerformance(areaId, grade) {
  if (!sessionPerformance[areaId]) {
    sessionPerformance[areaId] = { correct: 0, partial: 0, incorrect: 0 };
  }
  if (grade === "correct") sessionPerformance[areaId].correct++;
  else if (grade === "partial") sessionPerformance[areaId].partial++;
  else sessionPerformance[areaId].incorrect++;
  savePerformance();
  updateScoreTally();
}

function updateScoreTally() {
  const totals = Object.values(sessionPerformance).reduce(
    (acc, s) => {
      acc.correct += s.correct;
      acc.partial += (s.partial || 0);
      acc.incorrect += s.incorrect;
      return acc;
    },
    { correct: 0, partial: 0, incorrect: 0 }
  );
  const el = document.getElementById("score-tally");
  if (!el) return;
  const total = totals.correct + totals.partial + totals.incorrect;
  const parts = [`${totals.correct} correct`];
  if (totals.partial > 0) parts.push(`${totals.partial} partial`);
  parts.push(`${totals.incorrect} incorrect`);
  if (total > 0) {
    const pct = Math.round((totals.correct + totals.partial * 0.5) / total * 100);
    parts.push(`${pct}% overall`);
  }
  el.textContent = parts.join(" / ");
}

// ===============================
// 5. PROGRESS UI
// ===============================

function updateProgressUI() {
  const totalAreas = config.areasOfOperation.length;
  const pct = Math.round((currentAreaIndex / totalAreas) * 100);
  document.getElementById("progress-bar").style.width = pct + "%";

  const area = config.areasOfOperation[currentAreaIndex];
  if (!area) return;

  const task = currentAreaTasks[currentTaskIndex] ?? null;
  document.getElementById("progress-label").textContent =
    `Area ${area.id} of ${totalAreas}`;
  document.getElementById("area-label").textContent =
    `Area ${area.id}: ${area.title}` +
    (task ? ` — Task ${task.id}: ${task.title}` : "");
}

// ===============================
// 6. SESSION FLOW
// ===============================

async function askNextQuestion() {
  fullExamAreaQuestionCount++;

  const area = config.areasOfOperation[currentAreaIndex];
  const task = currentAreaTasks[currentTaskIndex] ?? null;

  // Reset UI
  document.getElementById("answer").value = "";
  document.getElementById("feedback").textContent = "";
  document.getElementById("feedback-card").classList.add("hidden");
  document.getElementById("feedback-card").classList.remove("correct", "incorrect", "partial");
  document.getElementById("answer-card").classList.remove("hidden");
  document.getElementById("submit").disabled = false;
  const challengeBtn = document.getElementById("challenge-btn");
  if (challengeBtn) {
    challengeBtn.textContent = "Challenge This Grade";
    challengeBtn.dataset.challenged = "false";
    challengeBtn.disabled = false;
  }

  updateProgressUI();

  document.getElementById("scenario-card").classList.remove("hidden");
  document.getElementById("scenario").textContent = "Generating your question…";
  document.getElementById("question").textContent = "";

  let llmData;
  try {
    const prompt = await buildPrompt(area, task);
    llmData = await callLLM(prompt);
  } catch (err) {
    showError(err.message || "The AI engine did not respond. Please try again.");
    return;
  }

  if (llmData.scenario === "The AI returned an unexpected response.") {
    showError("The AI returned an unexpected response. Please try again.");
    return;
  }

  currentLLMData = llmData;

  if (llmData.question) {
    const a = config.areasOfOperation[currentAreaIndex];
    if (a) {
      if (!recentQuestionsByArea[a.id]) recentQuestionsByArea[a.id] = [];
      const recent = recentQuestionsByArea[a.id];
      recent.push(llmData.question.slice(0, 300));
      if (recent.length > RECENT_QUESTION_MEMORY) recent.shift();
    }
  }

  const scenarioText = llmData.scenario || "";
  const scenarioCard = document.getElementById("scenario-card");
  if (scenarioText) {
    document.getElementById("scenario").textContent = scenarioText;
    scenarioCard.classList.remove("hidden");
  } else {
    scenarioCard.classList.add("hidden");
  }
  document.getElementById("question").textContent = llmData.question || "";
}

function moveToNextTask() {
  currentTaskIndex++;
  if (currentTaskIndex >= currentAreaTasks.length) {
    moveToNextArea();
  } else {
    askNextQuestion();
  }
}

function moveToNextArea() {
  const finishedArea = config.areasOfOperation[currentAreaIndex];
  if (finishedArea) {
    const stats = sessionPerformance[finishedArea.id] || { correct: 0, partial: 0, incorrect: 0 };
    const total = stats.correct + (stats.partial || 0) + stats.incorrect;
    const score = stats.correct + (stats.partial || 0) * 0.5;
    const passed = score >= areaPassThreshold(total);
    fullExamAreaResults[finishedArea.id] = { passed, stats };
    if (!passed && !currentAreaInExtension) {
      fullExamExtensionAvailable.add(finishedArea.id);
    }
  }

  currentAreaInExtension = false;
  currentAreaIndex++;
  currentTaskIndex = 0;
  fullExamAreaQuestionCount = 0;
  recentQuestionsByArea[config.areasOfOperation[currentAreaIndex - 1]?.id] = [];

  while (
    currentAreaIndex < config.areasOfOperation.length &&
    !hasApplicableTasks(config.areasOfOperation[currentAreaIndex], activeVariant)
  ) {
    currentAreaIndex++;
  }

  if (currentAreaIndex >= config.areasOfOperation.length) {
    startExtensionPhase();
  } else {
    currentAreaTasks = buildAreaTaskList(
      config.areasOfOperation[currentAreaIndex],
      activeVariant,
      false
    );
    askNextQuestion();
  }
}

function startExtensionPhase() {
  const nextFailedAreaId = [...fullExamExtensionAvailable][0];
  if (!nextFailedAreaId) {
    showCompletion();
    return;
  }
  showExtensionOffer(nextFailedAreaId);
}

function showExtensionOffer(areaId) {
  const area = config.areasOfOperation.find(a => a.id === areaId);
  const stats = fullExamAreaResults[areaId]?.stats || { correct: 0, partial: 0, incorrect: 0 };
  const total = stats.correct + (stats.partial || 0) + stats.incorrect;
  const pct = total > 0 ? Math.round((stats.correct + (stats.partial || 0) * 0.5) / total * 100) : 0;

  document.getElementById("single-area-title").textContent = `Area ${area.id} — Not Yet`;
  document.getElementById("single-area-score").textContent = `${pct}%`;
  document.getElementById("single-area-score").className = "big-score score-fail";
  document.getElementById("single-area-message").textContent =
    `You scored ${pct}% on Area ${area.id}: ${area.title}. ` +
    `You may attempt ${FULL_EXAM_EXTENSION_QUESTIONS} more questions to try to pass this area, ` +
    `or continue and review this area with your instructor.`;

  const moreBtn = document.getElementById("single-area-more");
  moreBtn.textContent = `Try ${FULL_EXAM_EXTENSION_QUESTIONS} more questions`;
  moreBtn.classList.remove("hidden");
  moreBtn.onclick = () => startAreaExtension(areaId);

  document.getElementById("single-area-done").onclick = () => {
    fullExamExtensionAvailable.delete(areaId);
    startExtensionPhase();
  };

  showScreen("single-area-complete");
}

function startAreaExtension(areaId) {
  fullExamExtensionAvailable.delete(areaId);
  const idx = config.areasOfOperation.findIndex(a => a.id === areaId);
  currentAreaIndex = idx;
  currentTaskIndex = 0;
  fullExamAreaQuestionCount = 0;
  currentAreaTasks = buildAreaTaskList(
    config.areasOfOperation[currentAreaIndex],
    activeVariant,
    true
  );
  currentAreaInExtension = true;
  showScreen("exam");
  askNextQuestion();
}

function showCompletion() {
  const totals = Object.values(sessionPerformance).reduce(
    (acc, s) => {
      acc.correct += s.correct;
      acc.partial += (s.partial || 0);
      acc.incorrect += s.incorrect;
      return acc;
    },
    { correct: 0, partial: 0, incorrect: 0 }
  );
  const total = totals.correct + totals.partial + totals.incorrect;
  const pct = total > 0 ? Math.round(((totals.correct + totals.partial * 0.5) / total) * 100) : 0;

  const areaResultIds = Object.keys(fullExamAreaResults);
  if (areaResultIds.length > 0) {
    const allPassed = areaResultIds.every(id => fullExamAreaResults[id].passed);
    let html = `<strong>${allPassed ? "Overall: PASS" : "Overall: NOT YET — see areas below"}</strong><br><br>`;
    html += "<table style='width:100%;text-align:left;border-collapse:collapse'>";
    html += "<tr><th>Area</th><th>Score</th><th>Result</th></tr>";
    for (const area of config.areasOfOperation) {
      const result = fullExamAreaResults[area.id];
      if (!result) continue;
      const s = result.stats;
      const t = s.correct + (s.partial || 0) + s.incorrect;
      const p = t > 0 ? Math.round((s.correct + (s.partial || 0) * 0.5) / t * 100) : 0;
      const icon = result.passed ? "✓" : "✗";
      html += `<tr><td>${area.id}: ${area.title}</td><td>${p}%</td><td>${icon}</td></tr>`;
    }
    html += "</table>";
    document.getElementById("complete-message").innerHTML = html;
  } else {
    const parts = [`${totals.correct} correct`];
    if (totals.partial > 0) parts.push(`${totals.partial} partial`);
    parts.push(`${totals.incorrect} incorrect`);
    document.getElementById("complete-message").textContent =
      `You answered ${parts.join(", ")} out of ${total} questions (${pct}% score). ` +
      `Great work completing the session!`;
  }

  showScreen("complete");
}

// ===============================
// 7. PROMPT BUILDER
// ===============================

async function buildPrompt(area, task) {
  const template = await fetch("prompts/oral_exam_prompt.txt").then(r => r.text());

  let variantContext = "";
  if (activeVariant) {
    const requiredTasks = (area.tasks || [])
      .filter(t => !t.variants || t.variants[activeVariant] === "required")
      .map(t => `${t.id}: ${t.title}`)
      .join(", ");
    const optionalTasks = (area.tasks || [])
      .filter(t => t.variants && t.variants[activeVariant] === "optional")
      .map(t => `${t.id}: ${t.title}`)
      .join(", ");
    variantContext =
      `Rating variant: ${activeVariant}\n` +
      (requiredTasks ? `Required tasks for this variant: ${requiredTasks}\n` : "") +
      (optionalTasks ? `Optional tasks for this variant (extension round only): ${optionalTasks}\n` : "") +
      (currentAreaInExtension
        ? "This is an EXTENSION ROUND — cover both required and optional tasks.\n"
        : "This is a BASE ROUND — focus on required tasks only.\n");
  }

  const recent = recentQuestionsByArea[area.id] || [];
  const recentContext = recent.length > 0
    ? "The following questions were ALREADY asked in this session. You MUST NOT ask about the same topic again — not with different wording, not with a different scenario, not as a follow-up. Pick a completely different concept from this area:\n" +
      recent.map((q, i) => `  ${i + 1}. ${q}`).join("\n")
    : "";

  return template
    .replace("{{certificate}}", config.certificate)
    .replace("{{areaTitle}}", area.title)
    .replace("{{areaId}}", area.id)
    .replace("{{taskId}}", task ? `${task.id}: ${task.title}` : "")
    .replace("{{depth}}", depthMode)
    .replace("{{aircraft}}", "generic training aircraft")
    .replace("{{acsUrl}}", config.acsUrl)
    .replace("{{PHAK}}", config.references.PHAK)
    .replace("{{AIM}}", config.references.AIM)
    .replace("{{FARs}}", config.references.FARs)
    .replace("{{AFH}}", config.references.AFH || "")
    .replace("{{variantContext}}", variantContext)
    .replace("{{recentContext}}", recentContext)
    .replace("{{localText}}", localTextCache);
}

// ===============================
// 8. LLM CALL
// ===============================

async function callLLM(prompt) {
  const response = await fetch("/api/oral-exam", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Beta-Token": BETA_API_TOKEN
    },
    body: JSON.stringify({ prompt })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  return await response.json();
}

// ===============================
// 9. STATS PING
// ===============================

// Fire-and-forget. Errors are silently swallowed.
async function pingStats(event) {
  await fetch("/api/stats", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Beta-Token": BETA_API_TOKEN
    },
    body: JSON.stringify({ event })
  });
}

// ===============================
// 10. SUBMIT HANDLER
// ===============================

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("submit").addEventListener("click", handleSubmit);
  document.getElementById("next").addEventListener("click", handleNext);
  document.getElementById("challenge-btn").addEventListener("click", openChallengeModal);
  document.getElementById("challenge-cancel").addEventListener("click", closeChallengeModal);
  document.getElementById("challenge-submit").addEventListener("click", submitChallenge);
  document.getElementById("single-area-more").addEventListener("click", () => {
    currentTaskIndex = 0;
    currentAreaTasks = buildAreaTaskList(
      config.areasOfOperation[currentAreaIndex],
      activeVariant,
      true
    );
    showScreen("exam");
    askNextQuestion();
  });
  document.getElementById("single-area-done").addEventListener("click", showCompletion);
});

async function handleSubmit() {
  const answer = document.getElementById("answer").value.trim();
  if (!answer) return;

  document.getElementById("submit").disabled = true;

  const area = config.areasOfOperation[currentAreaIndex];
  const task = currentAreaTasks[currentTaskIndex] ?? null;

  const evalPrompt = buildEvalPrompt(currentLLMData, answer, area, task);
  currentEvalPrompt = evalPrompt;  // save for challenge submissions

  let evalData;
  try {
    evalData = await callLLM(evalPrompt);
  } catch (err) {
    showError(err.message || "The AI engine did not respond. Please try again.");
    return;
  }

  const feedbackCard = document.getElementById("feedback-card");
  const feedbackEl = document.getElementById("feedback");
  document.getElementById("answer-card").classList.add("hidden");

  if (!evalData) {
    feedbackEl.textContent = "Could not get feedback. Your answer was recorded.";
    feedbackCard.classList.remove("hidden");
    recordPerformance(area.id, "incorrect");
    return;
  }

  const grade = evalData.evaluation?.grade ?? (evalData.evaluation?.correct ? "correct" : "incorrect");
  feedbackEl.textContent = evalData.evaluation?.feedback || evalData.evaluation || "Answer recorded.";
  feedbackCard.classList.remove("hidden", "correct", "partial", "incorrect");
  feedbackCard.classList.add(grade);

  recordPerformance(area.id, grade);

  // Ping stats: question answered
  pingStats("question_answered").catch(() => {});

  // Determine next action
  const areaLimit = currentAreaInExtension
    ? FULL_EXAM_EXTENSION_QUESTIONS
    : FULL_EXAM_BASE_QUESTIONS;

  if (fullExamAreaQuestionCount >= areaLimit) {
    feedbackCard.dataset.nextAction = "moveToNextArea";
  } else {
    feedbackCard.dataset.nextAction = evalData.nextAction || "askNextQuestion";
  }
}

function handleNext() {
  const feedbackCard = document.getElementById("feedback-card");
  const nextAction = feedbackCard.dataset.nextAction || "askNextQuestion";

  if (nextAction === "moveToNextTask") moveToNextTask();
  else if (nextAction === "moveToNextArea") moveToNextArea();
  else if (nextAction === "sessionComplete") showCompletion();
  else askNextQuestion();
}

// ===============================
// 11. EVAL PROMPT BUILDER
// ===============================

function buildEvalPrompt(originalResponse, studentAnswer, area, task) {
  const groundingNotes = (task?.groundingNotes) || area.groundingNotes || "";
  return JSON.stringify({
    role: "evaluator",
    certificate: config.certificate,
    areaId: area.id,
    areaTitle: area.title,
    taskId: task ? `${task.id}: ${task.title}` : "",
    depth: depthMode,
    acsUrl: config.acsUrl,
    originalScenario: originalResponse.scenario,
    originalQuestion: originalResponse.question,
    studentAnswer: studentAnswer,
    groundingNotes: groundingNotes,
    instruction:
      "You are grading a student's answer to a specific oral exam question. " +

      "STEP 1 — IDENTIFY WHAT WAS ASKED. " +
      "The exact question is in 'originalQuestion'. Read it literally and carefully. " +
      "Derive the grading rubric ONLY from the specific words in that question — " +
      "not from your general knowledge of the topic, not from related sub-topics, " +
      "and not from what a thorough answer to a broader question might include. " +
      "Example: if the question asks 'How do you check fuel quantity?', your rubric " +
      "covers fuel quantity checks only. Fuel quality, fuel color, and fuel sampling " +
      "are NOT part of the rubric even though you know they are part of a preflight — " +
      "they were not asked. " +

      "STEP 1B — IDENTIFY THE FORM OF ANSWER REQUESTED. " +
      "Beyond the topic, the question's operative words define what KIND of answer is required. " +
      "These are categorically different and must not be substituted for one another: " +
      "  'What must you have in your possession / carry / bring' " +
      "    → rubric covers only physical items the pilot holds or carries. " +
      "    Currency requirements, things to verify, and things to ensure are NOT physical items " +
      "    and must NOT be part of the rubric. " +
      "  'What must you ensure / verify / confirm' " +
      "    → rubric covers requirements the pilot must have met, not documents to carry. " +
      "  'Walk me through the procedure / steps' " +
      "    → rubric covers the sequence of actions, not definitions or regulations. " +
      "  'What does the FAR require / what are the limits' " +
      "    → rubric covers the regulatory standard only, not how to comply with it. " +
      "  'Explain / describe / what is' " +
      "    → rubric covers the concept or definition only. " +
      "CRITICAL EXAMPLE of this failure mode: " +
      "Question: 'What documentation must you have in your possession?' " +
      "Wrong rubric: penalizing student for not mentioning currency requirements or things to ensure. " +
      "Right rubric: physical documents only — certificate, medical, ID, endorsements if required. " +
      "Currency (3 takeoffs/landings, medical validity period) is a requirement to MEET, " +
      "not a document to CARRY — it is out of scope for a possession question. " +
      "Before grading, complete this test: " +
      "'The question asks [topic]. It asks for [form: possession / procedure / regulation / concept]. " +
      "A complete answer must address [topic] in the form of [form]. Nothing else is required.' " +
      "Then hold to that scope and form strictly throughout grading. " +

      "STEP 2 — APPLY SCENARIO CONTEXT. " +
      "If 'originalScenario' is empty or blank, skip Steps 2 and 2B entirely — there is no scenario. " +
      "Grade purely on whether the answer is factually correct and complete per FAA standards. " +
      "Do not invent or assume any situational constraints. " +
      "If 'originalScenario' is present, it established the conditions the student was placed in. " +
      "The student's answer must be correct for THOSE conditions — not for some other situation. " +
      "If the scenario places the student in cruise flight, do not penalize them for not discussing takeoff factors. " +
      "If the scenario specifies a particular aircraft type, altitude, weather, or phase of flight, " +
      "treat those as fixed constraints and grade within them. " +
      "CRITICAL — ONLY USE EXPLICITLY STATED DETAILS: " +
      "Do NOT assume any operational detail that was not explicitly written in the scenario. " +
      "This includes: time of day (day vs. night), weather conditions, pilot certificate level, " +
      "flight rules (VFR vs. IFR), airspace class, passenger status, and phase of flight. " +
      "If a detail is not stated in the scenario, treat it as unknown — do not assume it one way or the other. " +
      "If the student's answer is correct under any reasonable reading of the unstated conditions, " +
      "do not penalize them for it. " +
      "If a key condition was absent from the scenario and the correct answer genuinely depends on it, " +
      "note the ambiguity briefly in feedback but do not mark the answer incorrect solely because of that gap. " +
      "If there is a clear contradiction between scenario and question, note it briefly in feedback " +
      "but do not penalize the student — grade against the question as asked. " +

      "STEP 2B — MATCH PROCEDURES TO THE SCENARIO ENVIRONMENT. " +
      "The type of airport and airspace in the scenario determines which procedures are relevant. " +
      "Tower-specific procedures (light gun signals, ATC clearances, Class D radio calls, ATIS) " +
      "apply ONLY when the scenario places the student at a TOWERED airport. " +
      "Non-towered procedures (CTAF self-announce, UNICOM) apply ONLY at non-towered airports. " +
      "NEVER penalize a student for failing to mention a procedure that belongs to a different " +
      "airport environment than the one described in the scenario. " +
      "This principle extends to all environment-specific knowledge: IFR procedures do not apply " +
      "to a VFR-only scenario; night requirements do not apply to a daytime scenario; etc. " +

      "STEP 3 — GRADE NARROWLY. " +
      "A complete answer is one that correctly addresses what the question asked within the scenario context. " +
      "Before deducting for any omission, apply this gate: " +
      "Ask yourself — 'Is this missing element explicitly present in the question's wording?' " +
      "If NO, you may NOT deduct for its absence. Do not deduct because you know it is " +
      "related to the topic, because it is part of a broader procedure, or because a more " +
      "thorough answer would have included it. The question defines the rubric. Period. " +
      "Do NOT penalize for omitting information that was not asked for. " +
      "Do NOT penalize for not addressing factors that the scenario did not raise. " +
      "Do NOT upgrade a grade because the student said other correct things unrelated to the question. " +
      "If groundingNotes are provided, treat them as authoritative FAA facts — use them to verify specific claims. " +
      "CRITICAL: if any part of the answer contains a specific factual error (wrong direction, wrong number, " +
      "wrong procedure step, wrong control input), grade 'partial' or 'incorrect' regardless of what else was correct. " +

      "DECISION-BASED SCOPING: " +
      "If the student's answer includes a clear decision that resolves the situation — " +
      "such as 'I would not fly', 'I would not depart', 'I would land immediately', or 'I would divert' — " +
      "do NOT penalize them for failing to address what would happen under the opposite decision. " +
      "A student who correctly identifies an inoperative or out-of-limits item and states they will not fly " +
      "has given a complete and correct answer. They are not required to also discuss troubleshooting, " +
      "risk mitigation, or operational workarounds that only apply if they chose to fly anyway. " +
      "The same logic applies in flight: a student who says 'I would divert' or 'I would declare an emergency' " +
      "does not also need to explain how they would continue the flight under those conditions. " +
      "Grade the decision the student actually made — not the decision you expected them to make. " +

      "GRADING THRESHOLDS — apply these in order: " +
      "First check for factual errors. Any specific factual error (wrong number, wrong direction, wrong procedure step) " +
      "makes the answer 'incorrect' regardless of how much else was right. " +
      "If the answer is factually clean, then judge completeness: " +
      "'correct' — answer covers roughly 80% or more of what was asked; minor omissions are fine and should be " +
      "mentioned briefly in feedback but do not affect the grade. " +
      "'partial' — answer is factually accurate but only covers about 60–80% of what was asked; " +
      "meaningful elements are missing but the student clearly understands the core concept. " +
      "'incorrect' — answer contains a factual error, OR covers less than roughly 60% of what was asked " +
      "(missed the point entirely or gave a dangerously incomplete answer). " +
      "When in doubt between 'correct' and 'partial', lean toward 'correct' — " +
      "a student who gets the concept right and misses some detail is not failing a checkride. " +
      "Only use 'partial' when you can clearly identify a meaningful gap, not just an absence of elaboration. " +

      "Respond with a JSON object: " +
      '{ "evaluation": { "grade": "correct|partial|incorrect", "feedback": "..." }, ' +
      '"nextAction": "askNextQuestion | moveToNextTask | moveToNextArea | sessionComplete" }. ' +
      "In the feedback: address the student in second person ('You correctly...', 'You missed...'), " +
      "be concise, cite FAA references only where the student was wrong or incomplete, " +
      "and do NOT reference information from outside the question and scenario. " +
      "Do NOT include any text outside the JSON object."
  });
}

// ===============================
// 12. CHALLENGE MODAL
// ===============================

// Holds context about the question being challenged.
// Populated when the modal opens so it's available when the user submits.
let pendingChallengeContext = null;

function openChallengeModal() {
  const btn = document.getElementById("challenge-btn");
  if (btn.dataset.challenged === "true") return;

  const area = config.areasOfOperation[currentAreaIndex];
  const task = currentAreaTasks[currentTaskIndex] ?? null;
  const feedbackCard = document.getElementById("feedback-card");
  const grade = feedbackCard.classList.contains("correct") ? "correct"
              : feedbackCard.classList.contains("partial") ? "partial" : "incorrect";

  pendingChallengeContext = {
    timestamp: new Date().toISOString(),
    areaId: area.id,
    areaTitle: area.title,
    taskId: task ? `${task.id}: ${task.title}` : "",
    scenario: currentLLMData?.scenario || "",
    question: currentLLMData?.question || "",
    studentAnswer: document.getElementById("answer").value,
    aiGrade: grade,
    aiFeedback: document.getElementById("feedback").textContent,
    evalPrompt: currentEvalPrompt  // the full prompt sent to the AI for grading
  };

  document.getElementById("challenge-reason").value = "";
  document.getElementById("challenge-modal").classList.remove("hidden");
}

function closeChallengeModal() {
  document.getElementById("challenge-modal").classList.add("hidden");
  pendingChallengeContext = null;
}

async function submitChallenge() {
  if (!pendingChallengeContext) return;

  const reason = document.getElementById("challenge-reason").value.trim();
  const payload = { ...pendingChallengeContext, studentReason: reason };

  const submitBtn = document.getElementById("challenge-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/challenge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Beta-Token": BETA_API_TOKEN
      },
      body: JSON.stringify(payload)
    });

    closeChallengeModal();

    const challengeBtn = document.getElementById("challenge-btn");
    if (res.ok) {
      challengeBtn.textContent = "Challenged ✓ — thank you!";
      pingStats("challenge_filed").catch(() => {});
    } else {
      challengeBtn.textContent = "Challenge failed — try again";
    }
    challengeBtn.dataset.challenged = "true";
    challengeBtn.disabled = true;

  } catch {
    closeChallengeModal();
    const challengeBtn = document.getElementById("challenge-btn");
    challengeBtn.textContent = "Challenge failed — try again";
    challengeBtn.dataset.challenged = "true";
    challengeBtn.disabled = true;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Challenge";
    pendingChallengeContext = null;
  }
}

// ===============================
// 13. START
// ===============================

init();
