import { getDatabaseConfig } from "./config.js";
import { closeDatabase, pingDatabase } from "./database.js";

try {
  if (!getDatabaseConfig()) {
    console.error("MongoDB is not configured. Set MONGODB_URI in the repository root .env file.");
    process.exitCode = 1;
  } else {
    await pingDatabase();
    console.log("MongoDB connection verified: ping succeeded. No application records were written.");
  }
} catch {
  console.error("MongoDB connection failed. Check the database-user password, URI, IP access list, and cluster readiness. Credentials are omitted from this output.");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
