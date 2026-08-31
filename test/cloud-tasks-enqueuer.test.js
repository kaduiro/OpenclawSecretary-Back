import assert from "node:assert/strict";
import test from "node:test";
import { CloudTasksEnqueuer } from "../src/services/cloud-tasks-enqueuer.js";

function setup() {
  const calls = [];
  const client = {
    queuePath: () => "queue",
    taskPath: (_project, _location, _queue, name) => name,
    createTask: async (request) => calls.push(request),
  };
  const config = {
    cloudTasks: { project: "p", location: "l", queue: "q", targetUrl: "https://api.example.test" },
    serviceAccounts: { tasks: "tasks@example.test" },
    cloudRunAudience: "https://api.example.test",
  };
  return { enqueuer: new CloudTasksEnqueuer(config, client), calls };
}

test("outbox event type selects an allowlisted task target", async () => {
  const { enqueuer, calls } = setup();
  await enqueuer.enqueue({
    id: "event-1",
    event_type: "calendar_operation_execute",
    aggregate_id: "operation-1",
    payload: { operationId: "operation-1" },
  });
  assert.equal(calls[0].task.httpRequest.url, "https://api.example.test/internal/calendar/operations/operation-1/execute");
  const body = JSON.parse(Buffer.from(calls[0].task.httpRequest.body, "base64").toString("utf8"));
  assert.deepEqual(body, { operationId: "operation-1", outboxEventId: "event-1" });
});

test("unknown outbox event types fail closed", async () => {
  const { enqueuer } = setup();
  await assert.rejects(
    enqueuer.enqueue({ id: "event-1", event_type: "unknown", aggregate_id: "operation-1", payload: {} }),
    { code: "unknown_outbox_event_type" },
  );
});
