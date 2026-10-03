import { MongoClient, type Db } from "mongodb";
import { getDatabaseConfig } from "./config.js";

let client: MongoClient | undefined;
let connection: Promise<Db> | undefined;

export async function connectDatabase(): Promise<Db> {
  const config = getDatabaseConfig();
  if (!config) throw new Error("MONGODB_URI is not configured.");

  if (!connection) {
    const candidate = new MongoClient(config.uri, {
      appName: "ci-memory",
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      timeoutMS: 10_000,
    });
    client = candidate;
    connection = candidate.connect().then(() => candidate.db(config.name));
    connection = connection.catch(async (error: unknown) => {
      await candidate.close();
      connection = undefined;
      client = undefined;
      throw error;
    });
  }

  return connection;
}

export async function pingDatabase(): Promise<void> {
  const database = await connectDatabase();
  await database.command({ ping: 1 }, { timeoutMS: 8_000 });
}

export async function closeDatabase(): Promise<void> {
  const current = client;
  connection = undefined;
  client = undefined;
  await current?.close();
}
