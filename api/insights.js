import { apiKeyFromRequest, callOpenAI, modelName, requireApiKey, requirePost, responseText, safeJson, setJson } from "./_lib.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["headline","insights"],
  properties: {
    headline: { type: "string" },
    insights: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title","text"],
        properties: {
          title: { type: "string" },
          text: { type: "string" }
        }
      }
    }
  }
};

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireApiKey(req, res)) return;
  try {
    const { summary } = req.body || {};
    if (!summary) return setJson(res, 400, { error: "No summary." });
    const instructions = `Write concise Arabic financial insights from the supplied CALCULATED JSON only.
Do not recalculate or invent values. Do not shame the user. Do not give investment advice.
Focus on: biggest spending drivers, fixed-expense burden, transfers, discretionary spending, food/coffee/car, unusual high-spend days, merchant concentration, and classification coverage.
Use exact numbers already supplied. The UI is a dashboard, so keep each insight short and quantitative.
Calculated data:\n${JSON.stringify(summary).slice(0,300000)}`;
    const payload = await callOpenAI({
      model: modelName(),
      input: instructions,
      text: { format: { type: "json_schema", name: "financial_insights", strict: true, schema } }
    }, apiKeyFromRequest(req));
    setJson(res, 200, safeJson(responseText(payload)));
  } catch (e) {
    setJson(res, 500, { error: e?.message || "Insight generation failed" });
  }
}
