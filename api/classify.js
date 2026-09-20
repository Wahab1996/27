import { apiKeyFromRequest, callOpenAI, modelName, requireApiKey, requirePost, responseText, safeJson, setJson } from "./_lib.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["classifications"],
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index","merchant_normalized","category","subcategory","confidence","reason"],
        properties: {
          index: { type: "integer" },
          merchant_normalized: { type: "string" },
          category: { type: "string" },
          subcategory: { type: "string" },
          confidence: { type: "string", enum: ["CONFIRMED","HIGH","MEDIUM","LOW","UNRESOLVED"] },
          reason: { type: "string" }
        }
      }
    }
  }
};

const allowed = [
  "ثابت","تحويلات شخصية","السكن","السيارة","مطاعم وأكل","قهوة ومقاهي","بقالة ومقاضي",
  "الصحة والصيدليات","الاتصالات","تسوق وعناية","تسوق متخصص","عناية شخصية","خدمات منزلية",
  "مخالفات ورسوم","اشتراكات","سفر","تعليم","ترفيه","نقد / ATM","رسوم بنكية","أخرى","غير مصنف"
];

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireApiKey(req, res)) return;
  try {
    const { transactions = [], merchantMemory = {}, webLookup = true } = req.body || {};
    if (!Array.isArray(transactions) || !transactions.length) return setJson(res, 400, { error: "No transactions." });

    const compact = transactions.map((t, index) => ({
      index,
      date: t.date,
      amount: Number(t.debit || 0),
      merchant_raw: t.merchant_raw || "",
      description: t.original_description || "",
      transaction_kind: t.transaction_kind || ""
    })).filter(x => x.amount > 0);

    const instructions = `Classify personal bank-statement debit transactions. Be conservative and audit-friendly.
Allowed primary categories ONLY: ${allowed.join(" | ")}.
Rules:
- Do not invent the exact purchased item from the merchant category alone.
- Example: SASCO for SAR 4.50 may be "السيارة / شراء داخل محطة وقود", not necessarily fuel.
- For clear recurring obligations use category "ثابت" with explicit subcategory such as "قسط التمويل", "الإيجار", or "تمارا / شراء مؤجل".
- Personal transfers go to "تحويلات شخصية" and should preserve recipient in subcategory where possible.
- Merchant identity confidence and exact-item confidence are different; reflect uncertainty in confidence/reason.
- Use "غير مصنف" + "غير معروف" + UNRESOLVED if the evidence is not sufficient.
- Do not force a category merely to improve coverage.
- Use merchantMemory when it clearly matches after normalizing punctuation/case/reference noise.
- Return one classification for every supplied debit index, no duplicates and no missing debit indexes.
Merchant memory: ${JSON.stringify(merchantMemory).slice(0,120000)}
Transactions: ${JSON.stringify(compact).slice(0,650000)}`;

    const body = {
      model: modelName(),
      input: instructions,
      text: { format: { type: "json_schema", name: "transaction_classification", strict: true, schema } }
    };
    if (webLookup) body.tools = [{ type: "web_search" }];

    const payload = await callOpenAI(body, apiKeyFromRequest(req));
    setJson(res, 200, safeJson(responseText(payload)));
  } catch (e) {
    setJson(res, 500, { error: e?.message || "Classification failed" });
  }
}
