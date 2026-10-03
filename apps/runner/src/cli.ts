import { runFixture } from "./runner.js";
import { scenarios, type Scenario, type Schedule, type Scope } from "./types.js";

const values = process.argv.slice(2);
const options: Record<string, string> = {};
for (let index = 0; index < values.length; index += 2) {
  const key = values[index];
  const value = values[index + 1];
  if (!key || !["--scenario", "--scope", "--schedule"].includes(key) || !value || key in options) {
    console.error("Usage: demo --scenario billing|orders|missing-seed --scope shared|worker [--schedule cleanup-between-write-and-read|cleanup-before-write]");
    process.exit(2);
  }
  options[key] = value;
}
const scenario = options["--scenario"] ?? "billing";
const scope = options["--scope"] ?? "shared";
const schedule = options["--schedule"] ?? "cleanup-between-write-and-read";
if (!scenarios.includes(scenario as Scenario) || !["shared", "worker"].includes(scope) || !["cleanup-between-write-and-read", "cleanup-before-write"].includes(schedule)) {
  console.error("Unsupported fixture options.");
  process.exit(2);
}

try {
  const result = await runFixture({ scenario: scenario as Scenario, scope: scope as Scope, schedule: schedule as Schedule });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "passed" ? 0 : 1;
} catch {
  console.error("Demo infrastructure failed. Check Atlas connectivity and rebuild the runner. No failure result was fabricated.");
  process.exitCode = 2;
}
