import { apiKeyFromRequest, callOpenAI, modelName, requireApiKey, requirePost, responseText, safeJson, setJson } from "./_lib.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["bank_name","currency","statement_start","statement_end","opening_balance","closing_balance","bank_total_deposits","bank_total_withdrawals","bank_deposit_count","bank_withdrawal_count","transactions","warnings"],
  properties: {
    bank_name: { type: ["string","null"] },
    currency: { type: "string" },
    statement_start: { type: ["string","null"] },
    statement_end: { type: ["string","null"] },
    opening_balance: { type: ["number","null"] },
    closing_balance: { type: ["number","null"] },
    bank_total_deposits: { type: ["number","null"] },
    bank_total_withdrawals: { type: ["number","null"] },
    bank_deposit_count: { type: ["integer","null"] },
    bank_withdrawal_count: { type: ["integer","null"] },
    warnings: { type: "array", items: { type: "string" } },
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date","time","original_description","merchant_raw","debit","credit","balance","transaction_kind"],
        properties: {
          date: { type: ["string","null"] },
          time: { type: ["string","null"] },
          original_description: { type: "string" },
          merchant_raw: { type: "string" },
          debit: { type: "number" },
          credit: { type: "number" },
          balance: { type: ["number","null"] },
          transaction_kind: { type: "string" }
        }
      }
    }
  }
};

const instructions = `You extract bank statements into structured data. Accuracy is more important than guessing.
Rules:
- Never invent a transaction, amount, date, balance, merchant, or statement total.
- Preserve the bank's original transaction description in original_description.
- debit and credit must always be non-negative numbers. Use 0 when the opposite side does not apply.
- Parse all visible transactions, including transfers, financing, fees, POS, Apple Pay, internet purchases, ATM, deposits, reversals and reservations when they are booked as transactions.
- Use ISO date YYYY-MM-DD where reliably known. If not reliable, return null.
- statement_start/end are the bank statement period, not the generation date.
- merchant_raw should be the shortest useful merchant/beneficiary label that can be supported by the statement.
- Do not classify spending categories here.
- If a field cannot be supported, return null and add a concise warning.
- If the statement contains bank-reported opening/closing/deposit/withdrawal totals, copy them exactly.
Return only data matching the schema.`;

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireApiKey(req, res)) return;
  try {
    const { mode, text, fileData, filename, mimeType } = req.body || {};
    let content;
    if (mode === "image" && fileData) {
      content = [
        { type: "input_text", text: instructions },
        { type: "input_image", image_url: fileData, detail: "high" }
      ];
    } else if (mode === "file" && fileData) {
      const base64 = String(fileData).includes(",") ? String(fileData).split(",").pop() : String(fileData);
      content = [
        { type: "input_text", text: instructions },
        { type: "input_file", file_data: base64, filename: filename || "statement.pdf" }
      ];
    } else if (text && String(text).trim()) {
      content = [
        { type: "input_text", text: `${instructions}\n\nSTATEMENT CONTENT:\n${String(text).slice(0, 900000)}` }
      ];
    } else {
      return setJson(res, 400, { error: "No statement content received." });
    }

    const payload = await callOpenAI({
      model: modelName(),
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "bank_statement_extraction",
          strict: true,
          schema
        }
      }
    }, apiKeyFromRequest(req));
    setJson(res, 200, safeJson(responseText(payload)));
  } catch (e) {
    setJson(res, 500, { error: e?.message || "Extraction failed" });
  }
}
