# CI Memory

Investigate CI failures, verify fixes, and reuse team knowledge with MongoDB Atlas and AI.

CI Memory is a hackathon project for teams that repeatedly investigate similar
integration-test failures. It reproduces authored failures against MongoDB, stores
ordered evidence in Atlas, checks scoped repair memory before asking Gemini,
independently verifies bounded repairs, and saves only proven repairs for later use.
A matching error message alone is not proof of the same cause.

## Current status

The repository contains the TypeScript API foundation, health/readiness
endpoints, MongoDB connection checker, an executable integration-test reproducer,
and Atlas-backed run history with API execution, aggregation, and a live dashboard.
Gemini investigation, independent repair verification, and scoped Markdown skill
memory are implemented for the authored fixture contracts.

## Run locally

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run typecheck
npm run build
npm start
```

Open <http://127.0.0.1:3001/health>. The response should be:

```json
{"status":"ok","service":"ci-memory-api"}
```

No database or LLM credentials are required for `/health`. The API binds to
localhost. `PORT` can override the default port of 3001. `/ready` returns 503
until the database is configured and reachable.

## Connect MongoDB Atlas

1. Copy `.env.example` to `.env` at the repository root.
2. In Atlas, choose **Connect > Drivers > Node.js** and copy the URI into
   `MONGODB_URI`. Replace the password placeholder with the URL-encoded database
   user password. Do not use your Atlas account login password.
3. Keep `MONGODB_DB=ci_memory`. Add your current IP to the project's access list.
4. Run `npm run db:check` to verify connectivity with a read-only ping.
5. Start the API and visit <http://127.0.0.1:3001/ready>.

The environment file is loaded by the API regardless of your terminal working
directory. The checker never prints the URI or raw driver error. A successful
ping does not create application collections; those will appear after the
first application write. `.env` is ignored by Git.

## Run the failure reproducer

Requires a working `.env` database connection and permission to create and drop
temporary collections in `MONGODB_DB`. Build first with `npm run build`.

```sh
# Deliberately exits 1: another worker deletes a seeded record before its read.
npm run demo -- --scenario billing --scope shared

# Exits 0: worker-scoped collections preserve the reader's record.
npm run demo -- --scenario billing --scope worker

# The second module supports the same reproducible shared-state problem.
npm run demo -- --scenario orders --scope shared

# Same assertion, different cause: isolation still exits 1.
npm run demo -- --scenario missing-seed --scope worker

# A different scheduling order makes the unfixed shared fixture pass.
npm run demo -- --scenario billing --scope shared --schedule cleanup-before-write
```

The runner starts two Node worker threads, each with its own MongoDB connection.
It controls the operation ordering with messages, rather than timing sleeps.
The shared fixture performs a real insert, collection-wide cleanup, read, and
assertion. Each JSON result contains actual operation outcomes and an ordered
event trace. This controlled reproducer models shared-test cleanup interference;
it does not estimate how often a production test would fail randomly.

Only authored fixture commands are supported. This is not an arbitrary repository
executor or an OS/container sandbox. The runner never executes AI-generated code;
AI proposals are validated separately and can only select bounded authored repairs.
Collection names include a fresh run ID, and all destructive operations validate
ownership. Normal completion removes only those temporary collections. An abrupt
process kill can leave run-prefixed collections; no broad database cleanup is run.
Connection/infrastructure errors exit 2 and do not masquerade as test failures.

```sh
npm test                 # Ownership and HTTP validation checks; no credentials required.
npm run test:integration # Real Atlas operations; requires configured .env.
```

## Execute and browse saved runs

Open <http://127.0.0.1:3001/> for the dashboard. Its three case buttons execute
real fixtures through `POST /runs`; they do not play recorded results. History,
evidence, totals, and comparison bars all load saved Atlas records. Filters and
pagination preserve the repository context. Select a row to inspect its ordered
trace, or copy the complete result as JSON. A selected run has a `#run=...` link
that restores its evidence on reload. Observed-evidence summaries are deterministic
descriptions of trace events, not AI diagnoses.

Start the API with `npm start` after building. The API executes authored fixtures
and saves completed results in the `runs` collection of `MONGODB_DB`.
Outcome, ordered events, schema version, and timestamps are inserted as one
document. Test assertions can fail while the HTTP request succeeds: `201` means
the execution result was saved, and its `status` can be `failed` or `passed`.
Infrastructure or persistence errors return `503`; they do not become failed
test records. An execution interrupted before the save is not persisted yet.

```powershell
$base = 'http://127.0.0.1:3001'
$body = @{ scenario = 'billing'; scope = 'shared' } | ConvertTo-Json
$run = Invoke-RestMethod "$base/runs" -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/runs/$($run.runId)"
Invoke-RestMethod "$base/runs?limit=10&status=failed"
Invoke-RestMethod "$base/runs/summary"
```

| Endpoint | Purpose |
| --- | --- |
| `POST /runs` | Execute `scenario`, `scope`, and optional `schedule`; return the saved trace. |
| `GET /runs` | Latest summaries, without events; filters `scenario`, `scope`, `status`. |
| `GET /runs/:runId` | Full saved result and evidence in order. |
| `GET /runs/summary` | MongoDB aggregation of counts and mean duration by scenario, scope, and outcome. |

History defaults to 20 records and allows `limit=1..50`. Pass the returned
`nextCursor` as `cursor` while preserving filters for the next page. Ordering
uses start time and run ID, rather than unstable offset pages. Compound indexes
support repository history and comparisons. Duplicate run IDs cannot overwrite
existing evidence.

`CI_TEAM_ID` and `CI_REPOSITORY_ID` set the context on the server. Every history,
detail, cursor, and aggregation query includes both fields. Clients cannot set
them in the run request. The default context is this hackathon repository.
This local API has no user authentication yet; these query boundaries are not
a substitute for user authentication. Hosted writes require a demo access key.
By default local development listens only on loopback,
requires JSON for writes, rejects cross-origin run creation, caps bodies at
4 KB, and permits at most two simultaneous executions per process.

The CLI remains a standalone reproducer and does not save history. Use `POST /runs`
for persistent executions. Integration checks use a fresh, named test collection
and remove it afterward; normal application history is retained.

For development, run `npm run dev` in a separate terminal to watch and compile
TypeScript, then restart `npm start` after changes. This initial dev command
only compiles; it does not start or restart the API.

## Deploy the dashboard and API on Render

Use the repository's `render.yaml` with Render **New > Blueprint**, connected to
`main`. It creates one Free Node Web Service for the dashboard and API. The build
is `npm ci --include=dev && npm run build`; the start command is `npm start`.
Production binds to `0.0.0.0` and honors Render's `PORT`. Node 24 is configured.

Provide the complete `MONGODB_URI` and `GEMINI_API_KEY` privately during Blueprint
setup. Never add them to Git. `MONGODB_DB=ci_memory` preserves the existing demo
history. In the Render service's **Connect > Outbound** panel, copy its outbound IP ranges into Atlas
**Network Access**; your laptop's allowed IP does not cover the hosted server.

Render generates `DEMO_WRITE_TOKEN`. Copy it from that service's environment panel
into the dashboard's **Demo access key** field when presenting live runs. The key
is sent only in an authorization header, is not included in the public config,
and is not saved in browser storage. Public visitors can view the authored demo
history. Hosted execution stays read-only if the token is missing.

Render supplies `RENDER_EXTERNAL_URL` for HTTPS origin validation. Set
`PUBLIC_ORIGIN=https://your-domain.example` if using a custom domain. Test `/health`,
`/ready`, the dashboard, and one authorized run after deployment. Free services
can sleep after 15 minutes of inactivity; open the page ahead of the presentation.
Keep the local app available if the hosted instance is still starting.

Source: [Render Web Services](https://render.com/docs/web-services),
[Free services](https://render.com/docs/free),
[Outbound IP ranges](https://render.com/docs/outbound-ip-addresses).

## AI investigation and repair memory

Set `GEMINI_API_KEY` privately in local `.env` and Render Environment. The default
`GEMINI_MODEL` is `gemini-2.5-flash`; this setting can be overridden on the server.
Select a failing run and click **Investigate & verify repair**. The service first
queries scoped active skills with the current fixture environment contract and
an unexpired seven-day lifetime. Ordered insert/cleanup/read evidence determines
the cause signature. A matching error message alone does not authorize reuse.

For a new cause, Gemini receives the authored fixture evidence and proposes a
bounded action with event citations. Output is validated before execution. The
supported actions are worker collection isolation or restoring the omitted seed
with isolation. No generated shell commands or arbitrary source code are executed.
A fresh runner executes the change under the failing insert-cleanup-read order.
Only a passing verification can create a skill. AI errors/quota limits are shown
honestly; no deterministic response is presented as an AI result.

Atlas stores `investigations` and `skills`, including source/verification run IDs,
the model or memory source, rejected reuse candidates, and Markdown `SKILL.md`
content. Skill version 1 includes its context, applicability, action, and evidence.
Skills can be downloaded and revoked from the dashboard; revoked/expired skills
are excluded from later reuse. This MVP supports the two authored fixture repair
contracts, not arbitrary repository editing or a general CI executor.

Demo: investigate a shared billing failure to learn isolation; run shared orders
and investigate to reuse it without an LLM call; run missing-seed and investigate
to reject isolation and verify a different repair. Already learned skills remain
in Atlas across deployments. Revoke a skill first if demonstrating a new diagnosis.

Endpoints: `POST /runs/:id/investigate`, `GET /runs/:id/investigation`, `GET /skills`,
`GET /skills/:id/markdown`, `POST /skills/:id/revoke`. Write routes use the same
demo access key and origin rules as fixture execution.

## Incremental delivery

1. API and TypeScript foundation.
2. Reproducible MongoDB integration-test failure and isolated runner.
3. Atlas run, event, and investigation storage.
4. AI diagnosis, patch proposal, and independent verification.
5. Versioned repair skills, applicability checks, and corrections.
6. Dashboard and a three-case demo: new failure, applicable reuse, rejected reuse.

Each milestone will use focused commits on a feature branch. Keep `main`
reviewable; do not bundle unrelated milestones into one commit.

## Free-first development

The intended setup uses Atlas Free, a rate-limited free LLM API, and local test
execution. Paid service upgrades are not required by this foundation. Do not
commit API keys, connection strings, `.env` files, or private CI logs.

## License

MIT. See [LICENSE](LICENSE).
