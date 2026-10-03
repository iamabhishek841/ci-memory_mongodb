import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { RequestError } from "./validation.js";

export function writePolicy(): { writeEnabled: boolean; writeAccessRequired: boolean } {
  const token = process.env.DEMO_WRITE_TOKEN?.trim();
  if (token && token.length < 24) throw new Error("DEMO_WRITE_TOKEN must be at least 24 characters.");
  return { writeEnabled: process.env.NODE_ENV !== "production" || !!token, writeAccessRequired: !!token };
}

export function requireWriteAccess(request: Pick<IncomingMessage, "headers">): void {
  const policy = writePolicy();
  if (!policy.writeEnabled) throw new RequestError(403, "This hosted demo is read-only until its operator configures a demo access key.");
  if (!policy.writeAccessRequired) return;
  const expected = Buffer.from(process.env.DEMO_WRITE_TOKEN!.trim());
  const header = request.headers.authorization || "";
  const supplied = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new RequestError(401, "Enter the demo access key to run a fixture.");
}
