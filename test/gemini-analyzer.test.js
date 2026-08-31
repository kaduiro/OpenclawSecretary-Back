import assert from "node:assert/strict";
import test from "node:test";
import { GeminiMailAnalyzer, GeminiUsageBudget, normalizeAnalysis } from "../src/ai/gemini-analyzer.js";

test("Gemini analysis values are bounded before persistence", () => {
  const result = normalizeAnalysis({
    category: "sales",
    urgency: "unexpected",
    summary: "summary",
    intent: "intent",
    actions: ["reply"],
    replyRequired: true,
    scheduleRelated: false,
    confidence: 2,
    replyDraft: "draft",
  });
  assert.equal(result.urgency, "medium");
  assert.equal(result.confidence, 1);
  assert.equal(result.replyDraft, "draft");
});

test("daily AI budget fails closed when the atomic claim is rejected", async () => {
  const budget = new GeminiUsageBudget({ query: async () => ({ rows: [] }) }, 10);
  await assert.rejects(budget.claim("flash-lite"), { code: "ai_daily_budget_exhausted" });
});

test("Flash-Lite handles low-risk classification without invoking Flash", async () => {
  const requests = [];
  const client = {
    request: async (request) => {
      requests.push(request);
      if (request.url.includes("dlp.googleapis.com")) return { data: { item: { value: "Subject: [PERSON_NAME]\nstatus update" } } };
      return {
        data: {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            category: "notice", urgency: "low", summary: "status", intent: "inform",
            actions: [], replyRequired: false, scheduleRelated: false, confidence: 0.95, replyDraft: "",
          }) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      };
    },
  };
  const db = { query: async () => ({ rows: [{ request_count: 1 }] }) };
  const analyzer = new GeminiMailAnalyzer({
    db,
    config: {
      googleCloudProject: "project",
      ai: { dailyRequestLimit: 100, maxOutputTokens: 800, flashLiteModel: "lite", flashModel: "flash" },
    },
    auth: { getClient: async () => client },
  });
  const result = await analyzer.analyze({ subject: "subject", body: "body" });
  assert.equal(result.replyRequired, false);
  assert.equal(requests.filter((request) => request.url.includes("aiplatform.googleapis.com")).length, 1);
  assert.match(requests[0].data.inspectConfig.infoTypes.map((item) => item.name).join(","), /PERSON_NAME/);
});
