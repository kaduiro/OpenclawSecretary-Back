import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { postgresConnectionOptions } from "../src/db-connection.js";

const { Client } = pg;
const connection = await postgresConnectionOptions(loadConfig(process.env));
const client = new Client({ ...connection.options, application_name: "openclaw-migrate" });
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

await client.connect();
try {
  await client.query(`SELECT pg_advisory_lock(hashtext('openclaw.schema_migrations'))`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);
  const filenames = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of filenames) {
    const sql = await fs.readFile(path.join(directory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await client.query("SELECT checksum FROM schema_migrations WHERE filename=$1", [filename]);
    if (applied.rowCount > 0) {
      if (!applied.rows[0].checksum) {
        await client.query("UPDATE schema_migrations SET checksum=$2 WHERE filename=$1", [filename, checksum]);
      } else if (applied.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration was modified: ${filename}`);
      }
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(filename,checksum) VALUES ($1,$2)", [filename, checksum]);
      await client.query("COMMIT");
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query(`SELECT pg_advisory_unlock(hashtext('openclaw.schema_migrations'))`).catch(() => {});
  await client.end();
  await connection.close();
}
