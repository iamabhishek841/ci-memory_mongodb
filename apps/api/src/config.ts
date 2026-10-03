import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

export function getDatabaseConfig(): { uri: string; name: string } | null {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return null;
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri) || /[<>]/.test(uri)) {
    throw new Error("Set a valid MONGODB_URI with all placeholders replaced in the root .env file.");
  }
  const name = process.env.MONGODB_DB?.trim() || "ci_memory";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(name)) {
    throw new Error("MONGODB_DB must start with a letter and contain only letters, numbers, or underscores.");
  }
  return { uri, name };
}

export function getPort(): number {
  const port = Number(process.env.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}
