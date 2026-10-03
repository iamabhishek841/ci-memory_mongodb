const $ = selector => document.querySelector(selector);
const state = { runs: [], cursor: null, selected: null, busy: false, historyVersion: 0, selectionVersion: 0 };
const labels = { billing: "Billing", orders: "Orders", "missing-seed": "Missing seed", shared: "Shared", worker: "Per worker" };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function notice(message, kind = "") {
  const target = $("#notice");
  target.className = `notice ${kind}`;
  target.textContent = message;
  target.hidden = !message;
}

function duration(ms) { return `${(ms / 1000).toFixed(2)} s`; }
function statusPill(status) { return element("span", `status-pill ${status}`, status === "passed" ? "✓ Passed" : "! Failed"); }

async function checkConnection() {
  const target = $("#connection");
  try {
    const response = await fetch("/ready", { signal: AbortSignal.timeout(15_000) });
    const body = await response.json();
    const ready = response.ok && body.database === "connected";
    target.className = `connection ${ready ? "ready" : "error"}`;
    $("#connection-label").textContent = ready ? "Atlas connected" : "Atlas unavailable";
  } catch {
    target.className = "connection error";
    $("#connection-label").textContent = "Connection unavailable";
  }
}

async function loadSummary() {
  const { groups } = await api("/runs/summary");
  const count = groups.reduce((total, group) => total + group.count, 0);
  const passing = groups.filter(group => group.status === "passed").reduce((total, group) => total + group.count, 0);
  $("#total-count").textContent = count;
  $("#nav-count").textContent = count;
  $("#passed-count").textContent = passing;
  $("#failed-count").textContent = count - passing;
  $("#average-duration").textContent = count ? duration(groups.reduce((sum, group) => sum + group.averageDurationMs * group.count, 0) / count) : "—";
  const target = $("#comparison-rows");
  target.replaceChildren();
  const maximum = Math.max(1, ...groups.map(group => group.count));
  for (const group of groups) {
    const row = element("div", "comparison-row");
    const name = element("div", "comparison-name");
    name.append(element("strong", "", labels[group.scenario] || group.scenario), element("small", "", `${labels[group.scope] || group.scope} collections`));
    const track = element("div", "bar-track");
    const fill = element("div", `bar-fill ${group.status}`);
    fill.style.width = `${group.count / maximum * 100}%`;
    track.append(fill);
    row.append(name, statusPill(group.status), track, element("span", "comparison-count", group.count), element("span", "comparison-time", duration(group.averageDurationMs)));
    target.append(row);
  }
  if (!groups.length) target.append(element("div", "empty-state", "Run a fixture to create the first comparison."));
}

function renderHistory() {
  const target = $("#history-rows");
  target.replaceChildren();
  for (const run of state.runs) {
    const row = element("tr", `run-row${state.selected?.runId === run.runId ? " selected" : ""}`);
    row.dataset.runId = run.runId;
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Inspect ${run.scenario} ${run.scope} run, ${run.status}`);
    row.setAttribute("aria-selected", String(state.selected?.runId === run.runId));
    const result = element("td");
    result.append(statusPill(run.status), element("div", "row-scenario", labels[run.scenario] || run.scenario));
    const scope = element("td");
    scope.append(element("span", "scope-pill", labels[run.scope] || run.scope));
    const started = new Date(run.startedAt);
    const date = element("td", "date-cell", started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    date.append(element("small", "", started.toLocaleDateString([], { month: "short", day: "numeric" })));
    row.append(result, scope, element("td", "duration-cell", duration(run.durationMs)), date);
    row.addEventListener("click", () => void selectRun(run.runId));
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void selectRun(run.runId); }
    });
    target.append(row);
  }
  $("#history-empty").hidden = state.runs.length > 0;
  $("#history-count").textContent = `${state.runs.length} loaded ${state.runs.length === 1 ? "record" : "records"}`;
  $("#load-more").hidden = !state.cursor;
  if (state.runs.length) $("#repository").textContent = state.runs[0].repositoryId;
}

async function loadHistory(append = false) {
  const version = ++state.historyVersion;
  const params = new URLSearchParams({ limit: "10" });
  if ($("#filter-status").value) params.set("status", $("#filter-status").value);
  if ($("#filter-scenario").value) params.set("scenario", $("#filter-scenario").value);
  if (append && state.cursor) params.set("cursor", state.cursor);
  $("#load-more").disabled = true;
  $("#history-count").textContent = "Loading history…";
  try {
    const data = await api(`/runs?${params}`);
    if (version !== state.historyVersion) return;
    state.runs = append ? [...state.runs, ...data.runs] : data.runs;
    state.cursor = data.nextCursor;
    renderHistory();
    if (!append && state.runs.length && !state.runs.some(run => run.runId === state.selected?.runId)) await selectRun(state.runs[0].runId);
  } catch (error) {
    if (version !== state.historyVersion) return;
    $("#history-count").textContent = "History unavailable";
    notice(error.message, "error");
  } finally {
    if (version === state.historyVersion) $("#load-more").disabled = false;
  }
}

function finding(run) {
  const cleanup = run.events.find(event => event.operation === "cleanup");
  const read = run.events.find(event => event.operation === "read");
  if (run.events.some(event => event.operation === "seed_skipped")) return ["The required seed was skipped", "The reader never had a record to retrieve. Collection isolation cannot replace the missing setup step."];
  if (cleanup?.deletedCount > 0 && read?.found === false) return ["Cleanup removed the record before its read", "The cleaner and reader addressed the same collection. The trace records one deletion followed by a missing record."];
  if (run.status === "passed" && run.scope === "worker") return ["The reader’s record survived cleanup", "The workers addressed different collections. Cleanup deleted zero reader records, and the assertion passed."];
  if (run.status === "passed") return ["This execution order preserved the record", "Cleanup happened before insertion. A passing run in this order does not verify the shared-state fix."];
  return ["The assertion failed", "Inspect the ordered operations below before proposing a repair."];
}

function eventDescription(event) {
  switch (event.operation) {
    case "connected": return ["Worker connected", "MongoDB connection established for this fixture."];
    case "insert": return ["Fixture record inserted", `Inserted ${event.recordId}.`];
    case "cleanup": return ["Collection cleanup executed", `deleteMany({}) removed ${event.deletedCount} ${event.deletedCount === 1 ? "record" : "records"}.`];
    case "read": return ["Reader queried its record", `${event.recordId}: ${event.found ? "record found" : "no record found"}.`];
    case "assertion": return [event.passed ? "Assertion passed" : "Assertion failed", event.message];
    case "seed_skipped": return ["Seed step skipped", event.message];
    case "collections_removed": return ["Temporary collections removed", event.message];
    default: return [event.operation, event.message || ""];
  }
}

function renderEvidence(run) {
  $("#evidence-empty").hidden = true;
  $("#evidence-content").hidden = false;
  $("#copy-evidence").disabled = false;
  $("#evidence-subtitle").textContent = `${labels[run.scenario] || run.scenario} · ${labels[run.scope]} collections · ${duration(run.durationMs)}`;
  $("#detail-status").className = `status-pill ${run.status}`;
  $("#detail-status").textContent = run.status === "passed" ? "✓ Passed" : "! Failed";
  $("#detail-id").textContent = run.runId;
  const [title, body] = finding(run);
  $("#finding-title").textContent = title;
  $("#finding-body").textContent = body;
  const target = $("#timeline");
  target.replaceChildren();
  for (const event of run.events) {
    const danger = event.passed === false || event.found === false || event.deletedCount > 0 || event.operation === "seed_skipped";
    const success = event.passed === true || event.operation === "collections_removed";
    const row = element("li", `timeline-item ${danger ? "danger" : success ? "success" : ""}`);
    const content = element("div");
    const [title, body] = eventDescription(event);
    const heading = element("div", "event-title", title);
    heading.append(element("small", "", `${event.workerId} · +${Math.max(0, new Date(event.at) - new Date(run.startedAt))}ms`));
    content.append(heading, element("p", "event-body", body));
    if (event.collection) content.append(element("div", "event-collection", event.collection));
    row.append(element("span", "event-marker", event.sequence), content);
    target.append(row);
  }
  $("#cleanup-label").textContent = "Fixture collections removed · Evidence retained in Atlas";
}

async function selectRun(runId) {
  const version = ++state.selectionVersion;
  $("#evidence-subtitle").textContent = "Loading saved evidence…";
  $("#copy-evidence").disabled = true;
  try {
    const run = await api(`/runs/${runId}`);
    if (version !== state.selectionVersion) return;
    state.selected = run;
    renderEvidence(run);
    renderHistory();
    history.replaceState(null, "", `#run=${runId}`);
  } catch (error) {
    if (version !== state.selectionVersion) return;
    $("#evidence-subtitle").textContent = "Evidence unavailable";
    notice(error.message, "error");
  }
}

async function refresh() {
  if (!state.busy) notice("");
  await Promise.all([checkConnection(), loadHistory(), loadSummary().catch(error => notice(error.message, "error"))]);
}

async function execute(scenario, scope, schedule = "cleanup-between-write-and-read") {
  if (state.busy) return;
  state.busy = true;
  const controls = document.querySelectorAll(".case-button, #run-form button, #run-form select, .filters select, #refresh");
  for (const control of controls) control.disabled = true;
  const started = Date.now();
  const progress = () => notice(`Workers are running against Atlas · ${((Date.now() - started) / 1000).toFixed(1)}s elapsed`, "busy");
  progress();
  const timer = setInterval(progress, 250);
  try {
    const run = await api("/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario, scope, schedule }) });
    clearInterval(timer);
    $("#filter-status").value = "";
    $("#filter-scenario").value = "";
    state.selected = run;
    renderEvidence(run);
    await Promise.all([loadHistory(), loadSummary()]);
    history.replaceState(null, "", `#run=${run.runId}`);
    notice(`${labels[scenario]} run saved to Atlas. Assertion ${run.status}; ${run.events.length} evidence events retained.`);
  } catch (error) {
    clearInterval(timer);
    notice(`${error.message} Refresh history to check for a completed result.`, "error");
  } finally {
    clearInterval(timer);
    state.busy = false;
    for (const control of controls) control.disabled = false;
    void checkConnection();
  }
}

$("#run-form").addEventListener("submit", event => { event.preventDefault(); void execute($("#scenario").value, $("#scope").value, $("#schedule").value); });
for (const button of document.querySelectorAll(".case-button")) button.addEventListener("click", () => void execute(button.dataset.scenario, button.dataset.scope));
for (const filter of document.querySelectorAll(".filters select")) filter.addEventListener("change", () => void loadHistory());
$("#load-more").addEventListener("click", () => void loadHistory(true));
$("#refresh").addEventListener("click", () => void refresh());
$("#copy-evidence").addEventListener("click", async () => {
  if (!state.selected) return;
  try { await navigator.clipboard.writeText(JSON.stringify(state.selected, null, 2)); notice("Saved evidence copied as JSON."); }
  catch { notice("Clipboard access was unavailable. The same JSON is available from the run detail API.", "error"); }
});

const initialRun = /^#run=([a-f0-9]{32})$/.exec(location.hash)?.[1];
await refresh();
if (initialRun) await selectRun(initialRun);
