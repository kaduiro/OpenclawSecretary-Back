export class ErrorService {
  constructor(db) {
    this.db = db;
  }

  async acknowledge(correlationId, attendeeRef) {
    const { rows } = await this.db.query(
      `INSERT INTO error_acknowledgements(correlation_id,attendee_ref) VALUES ($1,$2)
       ON CONFLICT (correlation_id,attendee_ref) DO UPDATE SET acknowledged_at=error_acknowledgements.acknowledged_at
       RETURNING acknowledged_at`,
      [correlationId, attendeeRef],
    );
    return { success: true, correlationId, acknowledgedAt: rows[0].acknowledged_at };
  }
}
