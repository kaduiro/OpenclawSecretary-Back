import { CloudTasksClient } from "@google-cloud/tasks";

const EVENT_TARGETS = Object.freeze({
  calendar_operation_execute: (event) => `/internal/calendar/operations/${event.aggregate_id}/execute`,
  gmail_poll: () => "/internal/poll-gmail",
  mail_send_reconcile: () => "/internal/mail-send/reconcile",
  oauth_compensate: () => "/internal/auth/compensate",
});

export class CloudTasksEnqueuer {
  constructor(config, client = new CloudTasksClient()) {
    this.config = config;
    this.client = client;
  }

  async enqueue(event) {
    const { project, location, queue, targetUrl } = this.config.cloudTasks;
    if (!project || !location || !queue || !targetUrl) throw new Error("Cloud Tasks configuration is incomplete");
    const target = EVENT_TARGETS[event.event_type];
    if (!target) {
      const error = new Error(`Unsupported outbox event type: ${event.event_type}`);
      error.code = "unknown_outbox_event_type";
      throw error;
    }
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      const error = new Error("Outbox payload must be an object");
      error.code = "invalid_outbox_payload";
      throw error;
    }
    const parent = this.client.queuePath(project, location, queue);
    const name = this.client.taskPath(project, location, queue, `outbox-${event.id}`);
    try {
      await this.client.createTask({
        parent,
        task: {
          name,
          httpRequest: {
            httpMethod: "POST",
            url: `${targetUrl}${target(event)}`,
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify({ ...event.payload, outboxEventId: event.id })).toString("base64"),
            oidcToken: { serviceAccountEmail: this.config.serviceAccounts.tasks, audience: this.config.cloudRunAudience },
          },
        },
      });
    } catch (error) {
      if (error.code !== 6) throw error;
    }
  }
}
