import { AuthTypes, Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

const ipTypes = Object.freeze({
  PRIVATE: IpAddressTypes.PRIVATE,
  PUBLIC: IpAddressTypes.PUBLIC,
  PSC: IpAddressTypes.PSC,
});

export async function postgresConnectionOptions(appConfig, { connector = new Connector() } = {}) {
  if (appConfig.nodeEnv !== "production") {
    return {
      options: appConfig.databaseUrl ? { connectionString: appConfig.databaseUrl } : {},
      close: async () => {},
    };
  }

  const database = appConfig.database || {};
  if (!database.instanceConnectionName || !database.name || !database.user) {
    throw new Error("INSTANCE_CONNECTION_NAME, DB_NAME, and DB_USER are required for Cloud SQL IAM authentication");
  }
  const ipType = ipTypes[database.ipType || "PRIVATE"];
  if (!ipType) throw new Error("DB_IP_TYPE must be PRIVATE, PUBLIC, or PSC");

  try {
    const connectorOptions = await connector.getOptions({
      instanceConnectionName: database.instanceConnectionName,
      authType: AuthTypes.IAM,
      ipType,
    });
    return {
      options: { ...connectorOptions, user: database.user, database: database.name },
      close: () => connector.close(),
    };
  } catch (error) {
    await connector.close();
    throw error;
  }
}
