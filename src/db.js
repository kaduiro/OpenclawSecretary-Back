import pg from "pg";
import { config } from "./config.js";
import { postgresConnectionOptions } from "./db-connection.js";

const { Pool } = pg;
const connection = await postgresConnectionOptions(config);

export const pool = new Pool({
  ...connection.options,
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  application_name: "openclaw-api",
});

export async function closePool() {
  await pool.end();
  await connection.close();
}

export async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
