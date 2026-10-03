const $ = selector => document.querySelector(selector);
const state = { runs: [], cursor: null, selected: null, busy: false, historyVersion: 0, selectionVersion: 0, writeEnabled: false, writeAccessRequired: false };
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

async function loadHistory(append = false, preserveSelection = false) {
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
    if (!preserveSelection && !append && state.runs.length && !state.runs.some(run => run.runId === state.selected?.runId)) await selectRun(state.runs[0].runId);
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
  $("#investigate-button").disabled = run.status !== "failed" || state.busy;
  $("#investigation-result").hidden = true;
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
    void loadInvestigation(runId);
  } catch (error) {
    if (version !== state.selectionVersion) return;
    $("#evidence-subtitle").textContent = "Evidence unavailable";
    notice(error.message, "error");
  }
}

async function refresh() {
  if (!state.busy) notice("");
  await Promise.all([checkConnection(), loadHistory(), loadSummary().catch(error => notice(error.message, "error")), loadSkills().catch(error => notice(error.message, "error"))]);
}

async function execute(scenario, scope, schedule = "cleanup-between-write-and-read") {
  if (state.busy) return;
  if (!state.writeEnabled) { notice("This hosted demo is currently read-only. You can inspect its saved runs below."); return; }
  if (state.writeAccessRequired && !$("#demo-key").value.trim()) { notice("Enter the demo access key below the fixture controls to start a run.", "error"); $("#demo-key").focus(); return; }
  state.busy = true;
  const controls = document.querySelectorAll(".case-button, #run-form button, #run-form select, .filters select, #refresh");
  for (const control of controls) control.disabled = true;
  const started = Date.now();
  const progress = () => notice(`Workers are running against Atlas · ${((Date.now() - started) / 1000).toFixed(1)}s elapsed`, "busy");
  progress();
  const timer = setInterval(progress, 250);
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.writeAccessRequired) headers.Authorization = `Bearer ${$("#demo-key").value.trim()}`;
    const run = await api("/runs", { method: "POST", headers, body: JSON.stringify({ scenario, scope, schedule }) });
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
    $("#investigate-button").disabled = state.selected?.status !== "failed";
    void checkConnection();
  }
}

function authorizedHeaders() {
  if (!state.writeEnabled) throw new Error("This demo is read-only. Its operator must enable write access.");
  const headers = { "Content-Type": "application/json" };
  if (state.writeAccessRequired) {
    const key = $("#demo-key").value.trim();
    if (!key) { $("#demo-key").focus(); throw new Error("Enter the demo access key before investigating."); }
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function renderInvestigation(result) {
  const target = $("#investigation-result");
  target.hidden = false;
  target.className = `investigation-result ${result.status === "rejected" ? "rejected" : ""}`;
  target.replaceChildren();
  target.append(element("strong", "", result.status === "verified" ? "✓ Repair verified by a real MongoDB run" : "Repair proposal rejected; no skill learned"));
  target.append(element("p", "", `${result.source === "memory" ? "Reused scoped memory · No LLM call" : `Gemini diagnosis · ${result.model}`} · ${result.plan.action}`));
  target.append(element("p", "", result.plan.rationale));
  target.append(element("p", "", `Cited evidence events: ${result.plan.evidenceSequences.join(", ")}`));
  for (const rejected of result.rejectedSkills) target.append(element("p", "", `Rejected reuse: ${rejected.title}. ${rejected.reason}`));
  if (result.verificationRunId) {
    const link = element("a", "", "Inspect the independent verification run →");
    link.href = `#run=${result.verificationRunId}`;
    link.addEventListener("click", event => { event.preventDefault(); void selectRun(result.verificationRunId); });
    target.append(link);
  }
  if (result.skillId) {
    const paragraph = element("p");
    const link = element("a", "", "Download the verified SKILL.md");
    link.href = `/skills/${result.skillId}/markdown`;
    paragraph.append(link);
    target.append(paragraph);
  }
}

async function loadInvestigation(runId) {
  try {
    const data = await api(`/runs/${runId}/investigation`);
    if (state.selected?.runId === runId && data.investigation) renderInvestigation(data.investigation);
  } catch {}
}

async function loadSkills() {
  const { skills } = await api("/skills");
  const target = $("#skill-list");
  target.replaceChildren();
  for (const skill of skills) {
    const card = element("details", "skill-card");
    card.append(element("summary", "", `${skill.title} · v${skill.version} · ${skill.status}`));
    card.append(element("div", "skill-meta", `${skill.repositoryId} · ${skill.signature} · expires ${new Date(skill.expiresAt).toLocaleDateString()}`));
    card.append(element("pre", "", skill.markdown));
    const actions = element("div", "skill-actions");
    const download = element("a", "", "Download SKILL.md");
    download.href = `/skills/${skill._id}/markdown`;
    actions.append(download);
    if (skill.status === "active") {
      const revoke = element("button", "button text-button skill-revoke", "Revoke skill");
      revoke.addEventListener("click", async () => {
        try {
          await api(`/skills/${skill._id}/revoke`, { method: "POST", headers: authorizedHeaders(), body: "{}" });
          await loadSkills();
          notice("Skill revoked. Later investigations will not reuse it.");
        } catch (error) { notice(error.message, "error"); }
      });
      actions.append(revoke);
    }
    card.append(actions);
    target.append(card);
  }
  if (!skills.length) target.append(element("div", "empty-state", "Investigate a failing run. A skill appears only after its repair passes verification."));
}

$("#investigate-button").addEventListener("click", async () => {
  if (state.busy || !state.selected || state.selected.status !== "failed") return;
  let headers;
  try { headers = authorizedHeaders(); } catch (error) { notice(error.message, "error"); return; }
  const runId = state.selected.runId;
  state.busy = true;
  const controls = document.querySelectorAll(".case-button, #run-form button, #run-form select, .filters select, #refresh, #investigate-button, .skill-revoke");
  for (const control of controls) control.disabled = true;
  notice("Checking scoped repair memory, asking Gemini if needed, then running independent verification…", "busy");
  try {
    const result = await api(`/runs/${runId}/investigate`, { method: "POST", headers, body: "{}" });
    if (state.selected?.runId === runId) renderInvestigation(result);
    await Promise.all([loadSummary(), loadSkills()]);
    await loadHistory(false, true);
    notice(result.status === "verified" ? `Repair verified. ${result.source === "memory" ? "Reused Atlas memory without an LLM call." : "Saved a verified skill to Atlas."}` : "Proposal rejected. No unverified skill was saved.");
  } catch (error) { notice(error.message, "error"); }
  finally {
    state.busy = false;
    for (const control of controls) control.disabled = false;
    $("#investigate-button").disabled = state.selected?.status !== "failed";
  }
});

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
try {
  const policy = await api("/app-config");
  state.writeEnabled = policy.writeEnabled;
  state.writeAccessRequired = policy.writeAccessRequired;
  $("#access-field").hidden = !policy.writeAccessRequired;
} catch { notice("Write access could not be checked. Refresh before starting a fixture.", "error"); }
await refresh();
if (initialRun) await selectRun(initialRun);
