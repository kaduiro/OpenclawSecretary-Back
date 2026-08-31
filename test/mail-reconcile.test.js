import assert from "node:assert/strict";
import test from "node:test";
import { MailSendOperationService } from "../src/services/mail-send-operation-service.js";

test("mail reconciliation resolves a provider match and clears the lease", async () => {
  const queries = [];
  const transaction = {
    query: async (sql, params) => {
      queries.push([sql, params]);
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const db = {
    query: async (sql) => {
      queries.push([sql]);
      if (sql.includes("UPDATE mail_send_operations") && sql.includes("RETURNING id,mail_id")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000010",
            mail_id: "00000000-0000-4000-8000-000000000011",
            draft_id: "draft-1",
            provider_message_id: null,
            operation_marker: "marker-1",
            reconcile_attempts: 1,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    connect: async () => transaction,
  };
  const provider = { findSentReply: async () => ({ messageId: "message-1" }) };
  const results = await new MailSendOperationService(db, provider).reconcileDue(10);
  assert.deepEqual(results, [{ operationId: "00000000-0000-4000-8000-000000000010", status: "succeeded" }]);
  assert.ok(queries.some(([sql]) => sql.includes("status='succeeded'")));
  assert.ok(queries.some(([sql]) => sql.includes("INSERT INTO timeline_events")));
});
