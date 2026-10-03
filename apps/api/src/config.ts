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

export function getHost(): string {
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host)) throw new Error("Unsupported HTTP bind address.");
  return host;
}

export function getPublicOrigin(): string | null {
  const value = process.env.PUBLIC_ORIGIN?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin.");
  return url.origin;
}
