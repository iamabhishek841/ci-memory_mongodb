# CI Memory

Investigate CI failures, verify fixes, and reuse team knowledge with MongoDB Atlas and AI.

CI Memory is a hackathon project for teams that repeatedly investigate similar
integration-test failures. The planned workflow collects evidence, reproduces a
failure, validates a proposed patch, and saves a scoped repair procedure for a
later investigation. A matching error message alone is not proof of the same cause.

## Current status

The repository currently contains the TypeScript API foundation, local health
and database-readiness endpoints, and a MongoDB connection checker. The test
runner, run persistence, AI investigation, skill memory, and dashboard are not
implemented yet.

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

For development, run `npm run dev` in a separate terminal to watch and compile
TypeScript, then restart `npm start` after changes. This initial dev command
only compiles; it does not start or restart the API.

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
