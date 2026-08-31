import { GoogleAuth } from "google-auth-library";
import { serviceUnavailable } from "../lib/errors.js";

const INFO_TYPES = [
  "PERSON_NAME",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "LOCATION",
  "ORGANIZATION_NAME",
  "DATE_OF_BIRTH",
  "CREDIT_CARD_NUMBER",
  "IBAN_CODE",
];

const responseSchema = {
  type: "OBJECT",
  properties: {
    category: { type: "STRING" },
    urgency: { type: "STRING", enum: ["high", "medium", "low", "none"] },
    summary: { type: "STRING" },
    intent: { type: "STRING" },
    actions: { type: "ARRAY", items: { type: "STRING" } },
    replyRequired: { type: "BOOLEAN" },
    scheduleRelated: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    replyDraft: { type: "STRING" },
  },
  required: ["category", "urgency", "summary", "intent", "actions", "replyRequired", "scheduleRelated", "confidence", "replyDraft"],
};

export class GeminiUsageBudget {
  constructor(db, dailyRequestLimit) {
    this.db = db;
    this.dailyRequestLimit = dailyRequestLimit;
  }

  async claim(route) {
    const liteIncrement = route === "flash-lite" ? 1 : 0;
    const flashIncrement = route === "flash" ? 1 : 0;
    const { rows } = await this.db.query(
      `INSERT INTO ai_usage_daily(usage_date,request_count,flash_lite_requests,flash_requests)
       VALUES (CURRENT_DATE,1,$1,$2)
       ON CONFLICT (usage_date) DO UPDATE
         SET request_count=ai_usage_daily.request_count+1,
             flash_lite_requests=ai_usage_daily.flash_lite_requests+$1,
             flash_requests=ai_usage_daily.flash_requests+$2,
             updated_at=now()
       WHERE ai_usage_daily.request_count<$3
       RETURNING request_count`,
      [liteIncrement, flashIncrement, this.dailyRequestLimit],
    );
    if (!rows[0]) throw serviceUnavailable("ai_daily_budget_exhausted", "AI daily request budget is exhausted");
  }

  async recordTokens(inputTokens, outputTokens) {
    await this.db.query(
      `UPDATE ai_usage_daily
          SET input_tokens=input_tokens+$1,output_tokens=output_tokens+$2,updated_at=now()
        WHERE usage_date=CURRENT_DATE`,
      [Math.max(0, Number(inputTokens) || 0), Math.max(0, Number(outputTokens) || 0)],
    );
  }
}

export class GeminiMailAnalyzer {
  constructor({ db, config, auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }) }) {
    this.config = config;
    this.auth = auth;
    this.budget = new GeminiUsageBudget(db, config.ai.dailyRequestLimit);
  }

  async analyze({ subject, body }) {
    const text = await this.#deidentify(`Subject: ${subject}\n\n${body}`.slice(0, 12_000));
    const first = await this.#generate("flash-lite", this.config.ai.flashLiteModel, text, "Classify this business email. Keep summaries concise and do not reconstruct redacted values.");
    if (!first.replyRequired && !first.scheduleRelated && first.confidence >= 0.8) return first;
    return this.#generate("flash", this.config.ai.flashModel, text, "Analyze this business email and create a concise reply draft when a reply is required. Never guess or reconstruct redacted values.");
  }

  async #deidentify(value) {
    const client = await this.auth.getClient();
    const response = await client.request({
      url: `https://dlp.googleapis.com/v2/projects/${encodeURIComponent(this.config.googleCloudProject)}/locations/global/content:deidentify`,
      method: "POST",
      data: {
        inspectConfig: { infoTypes: INFO_TYPES.map((name) => ({ name })) },
        deidentifyConfig: {
          infoTypeTransformations: {
            transformations: [{ primitiveTransformation: { replaceWithInfoTypeConfig: {} } }],
          },
        },
        item: { value },
      },
    });
    const redacted = response.data?.item?.value;
    if (typeof redacted !== "string" || !redacted.trim()) {
      throw serviceUnavailable("ai_deidentification_failed", "Mail de-identification failed");
    }
    return redacted;
  }

  async #generate(route, model, text, instruction) {
    await this.budget.claim(route);
    const client = await this.auth.getClient();
    const response = await client.request({
      url: `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.googleCloudProject)}/locations/global/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
      method: "POST",
      data: {
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: this.config.ai.maxOutputTokens,
          responseMimeType: "application/json",
          responseSchema,
        },
      },
    });
    await this.budget.recordTokens(
      response.data?.usageMetadata?.promptTokenCount,
      response.data?.usageMetadata?.candidatesTokenCount,
    );
    const raw = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    try {
      return normalizeAnalysis(JSON.parse(raw));
    } catch {
      throw serviceUnavailable("ai_response_invalid", "AI analysis returned an invalid structured response");
    }
  }
}

export function normalizeAnalysis(value) {
  const urgency = new Set(["high", "medium", "low", "none"]).has(value?.urgency) ? value.urgency : "medium";
  return Object.freeze({
    category: String(value?.category || "other").slice(0, 100),
    urgency,
    summary: String(value?.summary || "").slice(0, 2_000),
    intent: String(value?.intent || "").slice(0, 500),
    actions: Array.isArray(value?.actions) ? value.actions.slice(0, 10).map((item) => String(item).slice(0, 300)) : [],
    replyRequired: Boolean(value?.replyRequired),
    scheduleRelated: Boolean(value?.scheduleRelated),
    confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0)),
    replyDraft: String(value?.replyDraft || "").slice(0, 8_000),
  });
}
