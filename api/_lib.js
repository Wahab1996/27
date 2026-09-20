const OPENAI_URL = "https://api.openai.com/v1/responses";

export function setJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8").send(JSON.stringify(body));
}

export function requirePost(req, res) {
  if (req.method !== "POST") {
    setJson(res, 405, { error: "Method not allowed" });
    return false;
  }
  return true;
}

export function apiKeyFromRequest(req) {
  const raw = req?.headers?.["x-openai-api-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  return typeof key === "string" ? key.trim() : "";
}

export function requireApiKey(req, res) {
  const key = apiKeyFromRequest(req);
  if (!key || key.length < 20) {
    setJson(res, 401, { error: "أدخل مفتاح OpenAI API في الصفحة قبل بدء التحليل." });
    return false;
  }
  return true;
}

export function modelName() {
  return process.env.ANALYZER_MODEL || "gpt-5.6-luna";
}

export function responseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

export async function callOpenAI(body, apiKey) {
  if (!apiKey) throw new Error("Missing OpenAI API key for this request.");
  const r = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = payload?.error?.message || `OpenAI request failed (${r.status})`;
    throw new Error(msg);
  }
  return payload;
}

export function safeJson(text) {
  if (!text) throw new Error("Empty model response");
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("Model output was not valid JSON");
}
