import assert from "node:assert/strict";
import test from "node:test";
import { ResourceAuthorizer } from "../src/auth/resource-authorizer.js";

test("mail authorization requires an active business unit", async () => {
  let sql;
  const db = {
    query: async (statement) => {
      sql = statement;
      return { rows: [{ id: "mail-1", is_owner: false, is_member: true }], rowCount: 1 };
    },
  };
  await new ResourceAuthorizer(db).mail({ attendeeRef: "attendee-1" }, "mail-1");
  assert.match(sql, /JOIN business_units b/);
  assert.match(sql, /b\.disabled_at IS NULL/);
});
