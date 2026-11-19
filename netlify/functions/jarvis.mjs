// Jarvis chat — Netlify Function (v2). The Claude API key lives ONLY in the
// Netlify environment variable ANTHROPIC_API_KEY. It is never sent to the browser.
//
// Cost guards (change in Netlify → Environment variables, then redeploy):
//   JARVIS_DAILY_BUDGET_USD   default 0.50  — hard stop for the whole site per day (Eastern time)
//   JARVIS_DAILY_MESSAGE_CAP  default 300   — max visitor messages per day, all visitors combined
//   JARVIS_PER_VISITOR_DAILY  default 30    — max messages per visitor (IP) per day
//   JARVIS_MAX_TURNS          default 12    — max visitor messages in one conversation
//   JARVIS_MODEL              default claude-haiku-5-5
import { SYSTEM_PROMPT } from "../lib/jarvis-prompt.mjs";

const MODEL = process.env.JARVIS_MODEL || "claude-haiku-5-5";
const DAILY_BUDGET = Number(process.env.JARVIS_DAILY_BUDGET_USD || 0.5);
const DAILY_MSG_CAP = Number(process.env.JARVIS_DAILY_MESSAGE_CAP || 300);
const PER_VISITOR = Number(process.env.JARVIS_PER_VISITOR_DAILY || 30);
const MAX_TURNS = Number(process.env.JARVIS_MAX_TURNS || 12);
const MAX_CHARS = 600;      // per visitor message
const MAX_TOKENS = 400;     // per Jarvis reply
// Claude Haiku 5.5 list prices, USD per million tokens (prompts ≤100K tokens), Nov 2026.
const PRICE = { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 };

const ALLOWED_ORIGINS = ["https://customcraftedsites.org", "https://www.customcraftedsites.org"];
const FALLBACK =
  "Jarvis is taking a break right now. Call or text (516) 288-5999 (open daily 9 AM–9 PM), book a free call at https://customcraftedsites.org/book, or leave your name and number and Ali will call you back.";

// ---- usage counters (Netlify Blobs; falls back to memory if Blobs isn't available) ----
const mem = new Map();
async function store() {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore("jarvis-usage");
  } catch {
    return {
      async get(k) { return mem.get(k) ?? null; },
      async setJSON(k, v) { mem.set(k, v); },
    };
  }
}
function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}
async function readJSON(s, key, fallback) {
  try {
    const v = await s.get(key, { type: "json" });
    return v ?? fallback;
  } catch { return fallback; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const origin = req.headers.get("origin") || "";
  const isPreview = origin.endsWith(".netlify.app");
  if (origin && !ALLOWED_ORIGINS.includes(origin) && !isPreview) return json({ error: "forbidden" }, 403);
  if (!process.env.ANTHROPIC_API_KEY) return json({ reply: FALLBACK, lead: true, reason: "no_key" });

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  let msgs = Array.isArray(body?.messages) ? body.messages : [];
  msgs = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === "user" ? MAX_CHARS : 2000) }))
    .slice(-16);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "no message" }, 400);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();

  const userTurns = msgs.filter((m) => m.role === "user").length;
  if (userTurns > MAX_TURNS) {
    return json({
      reply: "We've covered a lot! For anything else, Ali can help you directly — call or text (516) 288-5999, or book a free call at https://customcraftedsites.org/book.",
      lead: true, limit: "conversation",
    });
  }

  // ---- daily caps ----
  const s = await store();
  const day = todayET();
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const dayKey = `day-${day}`;
  const ipKey = `ip-${day}-${ip.replace(/[^0-9a-fA-F:.]/g, "")}`;
  const usage = await readJSON(s, dayKey, { usd: 0, messages: 0 });
  const ipCount = Number(await readJSON(s, ipKey, 0)) || 0;
  if (usage.usd >= DAILY_BUDGET || usage.messages >= DAILY_MSG_CAP) {
    return json({ reply: FALLBACK, lead: true, limit: "daily" });
  }
  if (ipCount >= PER_VISITOR) {
    return json({ reply: FALLBACK, lead: true, limit: "visitor" });
  }

  // ---- call Claude ----
  let data;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: msgs,
      }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  } catch (e) {
    console.error("jarvis: claude error", e?.message);
    return json({ reply: FALLBACK, lead: true, reason: "upstream" });
  }

  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim() || FALLBACK;
  const u = data.usage || {};
  const cost =
    ((u.input_tokens || 0) * PRICE.input +
      (u.output_tokens || 0) * PRICE.output +
      (u.cache_read_input_tokens || 0) * PRICE.cacheRead +
      (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite) / 1e6;

  try {
    await s.setJSON(dayKey, { usd: +(usage.usd + cost).toFixed(6), messages: usage.messages + 1 });
    await s.setJSON(ipKey, ipCount + 1);
  } catch (e) { console.error("jarvis: counter write failed", e?.message); }

  const lead = text.includes("[[LEAD_FORM]]");
  return json({ reply: text.replace(/\[\[LEAD_FORM\]\]/g, "").trim(), lead });
};

export const config = { path: "/api/jarvis" };
