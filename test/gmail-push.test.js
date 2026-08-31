import assert from "node:assert/strict";
import test from "node:test";
import { decodeGmailNotification } from "../src/api-server.js";
import { GmailPollService } from "../src/services/gmail-poll-service.js";

test("Gmail Pub/Sub payload is decoded without persisting the plain address", () => {
  const data = Buffer.from(JSON.stringify({ emailAddress: "User@Example.com", historyId: "123" })).toString("base64");
  assert.deepEqual(decodeGmailNotification({ message: { data } }), {
    emailAddress: "User@Example.com",
    historyId: "123",
  });
  assert.equal(decodeGmailNotification({ message: { data: "not-json" } }), null);
});

test("unknown Gmail notification is acknowledged without provider access", async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  const provider = { pollMailbox: async () => { throw new Error("must not run"); } };
  const service = new GmailPollService(db, provider);
  assert.deepEqual(await service.runNotification({ emailAddress: "unknown@example.com" }), {
    status: "ignored",
    processed: 0,
  });
});

test("Gmail watch renewal persists expiration and initial history", async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM mailbox_poll_state s")) return { rows: [{ mailbox_ref: "mailbox-1", history_id: null }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const provider = { watchMailbox: async () => ({ historyId: "55", expiration: "2000000000000" }) };
  const service = new GmailPollService(db, provider);
  const result = await service.renewWatches("projects/p/topics/gmail", 10);
  assert.equal(result[0].status, "succeeded");
  assert.deepEqual(calls[1].params, ["mailbox-1", "55", 2000000000000]);
});
