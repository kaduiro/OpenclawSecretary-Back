import assert from "node:assert/strict";
import test from "node:test";
import { GoogleWorkspaceProvider } from "../src/providers/google-workspace-provider.js";

test("Gmail draft send uses a short-lived token resolved from Secret Manager", async () => {
  const requests = [];
  const db = {
    query: async (sql) => {
      if (sql.includes("COALESCE(owner_attendee_ref")) return { rows: [{ attendee_ref: "attendee-1" }], rowCount: 1 };
      if (sql.includes("provider_credentials")) return { rows: [{ secret_resource_name: "projects/p/secrets/s" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const oauth = {
    accessToken: async (resource) => {
      assert.equal(resource, "projects/p/secrets/s");
      return "access-token";
    },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: "message-1", threadId: "thread-1" }) };
  };
  const provider = new GoogleWorkspaceProvider(db, oauth, undefined, fetchImpl);
  const sent = await provider.sendReply({ mailId: "mail-1", draftId: "draft-1" });
  assert.deepEqual(sent, { messageId: "message-1", threadId: "thread-1" });
  assert.equal(requests[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send");
  assert.equal(requests[0].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(requests[0].options.body), { id: "draft-1" });
});
