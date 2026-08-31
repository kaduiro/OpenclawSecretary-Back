import assert from "node:assert/strict";
import test from "node:test";
import { AuthTypes, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { postgresConnectionOptions } from "../src/db-connection.js";

test("development keeps DATABASE_URL compatibility without creating a connector", async () => {
  const connection = await postgresConnectionOptions({ nodeEnv: "test", databaseUrl: "postgres://local/test" });
  assert.deepEqual(connection.options, { connectionString: "postgres://local/test" });
});

test("production uses automatic IAM authentication with explicit database identity", async () => {
  let request;
  let closed = false;
  const connector = {
    getOptions: async (value) => {
      request = value;
      return { host: "127.0.0.1", port: 5432, stream: () => {} };
    },
    close: async () => { closed = true; },
  };
  const connection = await postgresConnectionOptions({
    nodeEnv: "production",
    database: { instanceConnectionName: "project:region:instance", name: "openclaw", user: "runtime@project.iam", ipType: "PRIVATE" },
  }, { connector });

  assert.deepEqual(request, {
    instanceConnectionName: "project:region:instance",
    authType: AuthTypes.IAM,
    ipType: IpAddressTypes.PRIVATE,
  });
  assert.equal(connection.options.user, "runtime@project.iam");
  assert.equal(connection.options.database, "openclaw");
  await connection.close();
  assert.equal(closed, true);
});

test("production connector configuration fails closed", async () => {
  await assert.rejects(
    postgresConnectionOptions({ nodeEnv: "production", database: {} }, { connector: { close: async () => {} } }),
    /INSTANCE_CONNECTION_NAME/,
  );
});
