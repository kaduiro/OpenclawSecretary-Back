import assert from "node:assert/strict";
import test from "node:test";
import { ClaimService } from "../src/services/claim-service.js";

test("transfer targets return only the database-authorized pseudonymous members", async () => {
  const calls = [];
  const db = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return {
        rows: [
          { attendeeRef: "attendee-2", label: "manager" },
          { attendeeRef: "attendee-3", label: "Support lead" },
        ],
      };
    },
  };

  const result = await new ClaimService(db).transferTargets("mail-1", {
    attendeeRef: "attendee-1",
  });

  assert.deepEqual(result, {
    targets: [
      { attendeeRef: "attendee-2", label: "manager" },
      { attendeeRef: "attendee-3", label: "Support lead" },
    ],
  });
  assert.deepEqual(calls[0].parameters, ["mail-1", "attendee-1"]);
  assert.match(calls[0].sql, /target\.business_unit_ref=e\.business_unit_ref/);
  assert.match(calls[0].sql, /target\.attendee_ref<>\$2/);
  assert.match(calls[0].sql, /u\.provisioning_status='active'/);
});

test("transfer target discovery hides an inaccessible mail", async () => {
  const db = {
    queryCalls: 0,
    async query() {
      this.queryCalls += 1;
      if (this.queryCalls === 1) return { rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };

  await assert.rejects(
    new ClaimService(db).transferTargets("mail-1", { attendeeRef: "attendee-1" }),
    { status: 404, code: "not_found" },
  );
});
