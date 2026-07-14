/**
 * The Curator web UI: a single self-contained page (no external resources) so
 * it works offline, under the strict local-origin policy, and inside a compiled
 * binary. Served at `/`; talks to the read/write `/api` layer.
 */
export const WEBUI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗂</text></svg>" />
<title>Curator</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
    --panel: #f9fafb; --accent: #2563eb; --danger: #dc2626; --ok: #059669;
    --chip: #eef2ff; --chip-fg: #3730a3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --fg: #e6e6e6; --muted: #9aa0aa; --border: #2a2f3a;
      --panel: #161a22; --accent: #60a5fa; --danger: #f87171; --ok: #34d399;
      --chip: #1e2536; --chip-fg: #a5b4fc;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
  header h1 { font-size: 16px; margin: 0; font-weight: 650; }
  header .spacer { flex: 1; }
  .layout { display: grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 53px); }
  aside { border-right: 1px solid var(--border); padding: 12px; overflow-y: auto; }
  main { padding: 16px; overflow-y: auto; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 4px 0 8px; }
  button { font: inherit; cursor: pointer; border: 1px solid var(--border); background: var(--panel); color: var(--fg); padding: 6px 10px; border-radius: 6px; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.danger { color: var(--danger); }
  button.link { background: none; border: none; color: var(--accent); padding: 2px 4px; }
  input, textarea, select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; width: 100%; }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; min-height: 120px; resize: vertical; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row > * { flex: 0 0 auto; }
  .grow { flex: 1 1 auto; }
  .col-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
  .col-item:hover, .col-item.active { background: var(--panel); }
  .count { color: var(--muted); font-size: 12px; }
  .chip { display: inline-block; background: var(--chip); color: var(--chip-fg); border-radius: 999px; padding: 1px 8px; font-size: 12px; margin: 0 4px 4px 0; }
  .badge { font-size: 11px; border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  tr.rec { cursor: pointer; }
  tr.rec:hover td { background: var(--panel); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .muted { color: var(--muted); }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 14px; background: var(--panel); }
  .grid2 { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; }
  .grid2 div:nth-child(odd) { color: var(--muted); }
  label { display: block; margin: 8px 0 4px; color: var(--muted); font-size: 12px; }
  .msg { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
  .msg.err { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger); }
  .msg.ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .hidden { display: none; }
  .comment { border-left: 2px solid var(--border); padding: 4px 10px; margin: 6px 0; }
  .status-draft { color: var(--muted); }
  .status-verified { color: var(--ok); }
  .status-rejected { color: var(--danger); }
</style>
</head>
<body>
<header>
  <h1>🗂 Curator</h1>
  <span class="badge" id="ver"></span>
  <span class="spacer"></span>
  <button id="newCol">New collection</button>
  <button class="primary" id="newRec">New record</button>
  <button class="link" id="setToken">Token</button>
</header>
<div class="layout">
  <aside>
    <h2>Collections</h2>
    <div class="col-item" id="all-records"><span>All records</span></div>
    <div id="collections"></div>
  </aside>
  <main>
    <div id="msg"></div>
    <div id="view"></div>
  </main>
</div>
<script>
const state = { collections: [], collection: null, records: [], query: "", status: "", tag: "" };

function tokenHeader() {
  const t = localStorage.getItem("curator_token");
  return t ? { Authorization: "Bearer " + t } : {};
}
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "content-type": "application/json", ...tokenHeader(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    const t = prompt("This daemon requires a bearer token. Enter it:");
    if (t) { localStorage.setItem("curator_token", t); return api(path, opts); }
    throw new Error("Unauthorized");
  }
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function short(id) { return String(id).slice(0, 8); }
function fmt(ts) { return ts ? new Date(ts).toLocaleString() : ""; }
function msg(text, kind = "ok") { const m = document.getElementById("msg"); m.innerHTML = text ? '<div class="msg ' + kind + '">' + esc(text) + "</div>" : ""; if (text) setTimeout(() => (m.innerHTML = ""), 4000); }
function statusClass(s) { return "status-" + s; }

async function loadCollections() {
  const { collections } = await api("/collections");
  state.collections = collections;
  const el = document.getElementById("collections");
  el.innerHTML = collections.map((c) =>
    '<div class="col-item" data-col="' + esc(c.name) + '"><span>' + esc(c.name) +
    (c.current_schema_version ? ' <span class="badge">schema v' + c.current_schema_version + "</span>" : "") +
    '</span><span class="count">' + c.record_count + "</span></div>"
  ).join("");
  el.querySelectorAll("[data-col]").forEach((n) => n.onclick = () => selectCollection(n.dataset.col));
  document.querySelectorAll(".col-item").forEach((n) => n.classList.toggle("active",
    (n.dataset.col || null) === state.collection || (n.id === "all-records" && !state.collection)));
}
function selectCollection(name) { state.collection = name; loadRecords(); loadCollections(); }

async function loadRecords() {
  const p = new URLSearchParams();
  if (state.query) p.set("query", state.query);
  if (state.collection) p.set("collection", state.collection);
  if (state.status) p.set("status", state.status);
  if (state.tag) p.set("tag", state.tag);
  const { results } = await api("/records?" + p.toString());
  state.records = results;
  renderList();
}

function renderList() {
  const schemaBtn = state.collection
    ? '<button id="schemaBtn">Schema' + (currentCol()?.current_schema_version ? " v" + currentCol().current_schema_version : "") + "</button>"
    : "";
  document.getElementById("view").innerHTML =
    '<div class="row" style="margin-bottom:12px">' +
      '<input class="grow" id="q" placeholder="Full-text search…" value="' + esc(state.query) + '" />' +
      '<select id="st"><option value="">any status</option>' +
        ["draft", "verified", "rejected"].map((s) => '<option ' + (state.status === s ? "selected" : "") + ">" + s + "</option>").join("") +
      "</select>" +
      '<input id="tg" placeholder="tag" value="' + esc(state.tag) + '" style="width:120px" />' +
      schemaBtn +
    "</div>" +
    "<h2>" + (state.collection ? esc(state.collection) : "All records") + " · " + state.records.length + "</h2>" +
    '<table><thead><tr><th>id</th><th>collection</th><th>status</th><th>ver</th><th>tags</th><th>updated</th></tr></thead><tbody>' +
    state.records.map((r) =>
      '<tr class="rec" data-id="' + esc(r.id) + '">' +
      '<td class="mono">' + short(r.id) + "</td>" +
      "<td>" + esc(r.collection) + "</td>" +
      '<td class="' + statusClass(r.status) + '">' + r.status + "</td>" +
      "<td>" + r.version + (r.schema_version ? '<span class="muted"> / s' + r.schema_version + "</span>" : "") + "</td>" +
      "<td>" + (r.tags || []).map((t) => '<span class="chip">' + esc(t) + "</span>").join("") + "</td>" +
      '<td class="muted">' + fmt(r.updated_at) + "</td></tr>"
    ).join("") +
    "</tbody></table>";
  const q = document.getElementById("q");
  q.oninput = debounce(() => { state.query = q.value.trim(); loadRecords(); }, 250);
  document.getElementById("st").onchange = (e) => { state.status = e.target.value; loadRecords(); };
  const tg = document.getElementById("tg");
  tg.oninput = debounce(() => { state.tag = tg.value.trim(); loadRecords(); }, 250);
  document.querySelectorAll("tr.rec").forEach((n) => n.onclick = () => openRecord(n.dataset.id));
  const sb = document.getElementById("schemaBtn");
  if (sb) sb.onclick = () => openSchema(state.collection);
}
function currentCol() { return state.collections.find((c) => c.name === state.collection); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function openRecord(id) {
  const rec = await api("/records/" + encodeURIComponent(id));
  const { comments } = await api("/records/" + encodeURIComponent(id) + "/comments");
  const { history } = await api("/records/" + encodeURIComponent(id) + "/history");
  const { links } = await api("/records/" + encodeURIComponent(id) + "/links");
  document.getElementById("view").innerHTML =
    '<button class="link" id="back">← back</button>' +
    '<div class="card"><div class="grid2">' +
      "<div>id</div><div class='mono'>" + esc(rec.id) + "</div>" +
      "<div>collection</div><div>" + esc(rec.collection) + "</div>" +
      "<div>version</div><div>" + rec.version + "</div>" +
      "<div>schema version</div><div>" + (rec.schema_version ?? "—") + "</div>" +
      "<div>created</div><div>" + fmt(rec.created_at) + " by " + esc(rec.created_by ?? "—") + "</div>" +
      "<div>updated</div><div>" + fmt(rec.updated_at) + " by " + esc(rec.updated_by ?? "—") + "</div>" +
      (rec.deleted_at ? "<div>deleted</div><div class='status-rejected'>" + fmt(rec.deleted_at) + "</div>" : "") +
    "</div></div>" +
    '<div class="card">' +
      "<label>content (JSON)</label><textarea id='content'></textarea>" +
      "<div class='row' style='margin-top:8px'>" +
        "<div><label>status</label><select id='rstatus'>" +
          ["draft", "verified", "rejected"].map((s) => "<option " + (rec.status === s ? "selected" : "") + ">" + s + "</option>").join("") +
        "</select></div>" +
        "<div class='grow'><label>source</label><input id='rsource' /></div>" +
      "</div>" +
      "<label>tags (comma separated)</label><input id='rtags' value='" + esc((rec.tags || []).join(", ")) + "' />" +
      "<label>author (your agent id)</label><input id='rauthor' placeholder='e.g. agent-web' />" +
      "<div class='row' style='margin-top:10px'>" +
        "<button class='primary' id='save'>Save</button>" +
        "<button id='migrate'>Migrate to current schema</button>" +
        "<span class='spacer grow'></span>" +
        "<button class='danger' id='del'>Delete</button>" +
        "<button class='danger' id='delhard'>Delete (hard)</button>" +
      "</div>" +
    "</div>" +
    '<div class="card"><h2>Comments</h2><div id="comments">' +
      (comments.length ? comments.map((c) => '<div class="comment"><b>' + esc(c.author ?? "anon") + '</b> <span class="muted">' + fmt(c.created_at) + "</span><br>" + esc(c.body) + "</div>").join("") : "<span class='muted'>No comments</span>") +
      "</div><div class='row' style='margin-top:8px'><input class='grow' id='cbody' placeholder='Add a comment…' /><input id='cauthor' placeholder='author' style='width:120px' /><button id='addc'>Add</button></div></div>" +
    '<div class="card"><h2>Links</h2><div id="links">' +
      (links.length
        ? links.map((l) =>
            "<div class='row' style='justify-content:space-between'>" +
            "<div><span class='badge'>" + (l.direction === "out" ? "→ " : "← ") + esc(l.rel) + "</span> " +
            "<button class='link openlink' data-id='" + esc(l.record.id) + "'>" + esc(l.record.collection) + " · " + short(l.record.id) + "</button>" +
            (l.record.deleted_at ? " <span class='status-rejected'>(deleted)</span>" : "") +
            (l.note ? " <span class='muted'>— " + esc(l.note) + "</span>" : "") + "</div>" +
            "<button class='link rmlink' data-dir='" + l.direction + "' data-other='" + esc(l.record.id) + "' data-rel='" + esc(l.rel) + "'>remove</button>" +
            "</div>")
          .join("")
        : "<span class='muted'>No links</span>") +
      "</div><div class='row' style='margin-top:8px'>" +
        "<input class='grow' id='ltoid' placeholder='target record id' />" +
        "<input id='lrel' placeholder='rel (e.g. cites)' style='width:140px' />" +
        "<input id='lnote' placeholder='note (optional)' style='width:160px' />" +
        "<button id='addlink'>Link</button>" +
      "</div></div>" +
    '<div class="card"><h2>History</h2>' +
      history.map((h) => "<div class='row'><span class='badge'>v" + h.version + "</span> <span class='muted'>" + fmt(h.changed_at) + " by " + esc(h.changed_by ?? "—") + "</span> <span class='" + statusClass(h.status) + "'>" + h.status + "</span></div>").join("") +
    "</div>";
  document.getElementById("content").value = JSON.stringify(rec.content, null, 2);
  document.getElementById("rsource").value = rec.source ?? "";
  document.getElementById("back").onclick = () => renderList();
  document.getElementById("save").onclick = () => saveRecord(rec);
  document.getElementById("migrate").onclick = () => migrateRecord(rec);
  document.getElementById("del").onclick = () => deleteRecord(rec.id, false);
  document.getElementById("delhard").onclick = () => deleteRecord(rec.id, true);
  document.getElementById("addc").onclick = () => addComment(rec.id);
  document.getElementById("addlink").onclick = () => addLink(rec.id);
  document.querySelectorAll(".openlink").forEach((n) => (n.onclick = () => openRecord(n.dataset.id)));
  document.querySelectorAll(".rmlink").forEach((n) => (n.onclick = () => removeLink(rec.id, n.dataset)));
}

async function addLink(id) {
  const to = document.getElementById("ltoid").value.trim();
  if (!to) return msg("Enter a target record id", "err");
  const rel = document.getElementById("lrel").value.trim() || undefined;
  const note = document.getElementById("lnote").value.trim() || undefined;
  try {
    await api("/records/" + encodeURIComponent(id) + "/links", { method: "POST", body: JSON.stringify({ to_id: to, rel, note }) });
    msg("Linked."); openRecord(id);
  } catch (e) { msg(e.message, "err"); }
}
async function removeLink(id, data) {
  // For outgoing links the current record is the source; for incoming it is the target.
  const from = data.dir === "out" ? id : data.other;
  const to = data.dir === "out" ? data.other : id;
  if (!confirm("Remove this link?")) return;
  try {
    await api("/records/" + encodeURIComponent(from) + "/links?to=" + encodeURIComponent(to) + "&rel=" + encodeURIComponent(data.rel), { method: "DELETE" });
    msg("Link removed."); openRecord(id);
  } catch (e) { msg(e.message, "err"); }
}

function parseContent() {
  try { return { ok: true, value: JSON.parse(document.getElementById("content").value) }; }
  catch (e) { return { ok: false, error: "Content is not valid JSON: " + e.message }; }
}
function tagsFromInput() { return document.getElementById("rtags").value.split(",").map((t) => t.trim()).filter(Boolean); }

async function saveRecord(rec) {
  const c = parseContent();
  if (!c.ok) return msg(c.error, "err");
  try {
    await api("/records/" + encodeURIComponent(rec.id), { method: "PATCH", body: JSON.stringify({
      content: c.value, source: document.getElementById("rsource").value || undefined,
      status: document.getElementById("rstatus").value, tags: tagsFromInput(),
      author: document.getElementById("rauthor").value || undefined,
      expected_version: rec.version,
    }) });
    msg("Saved."); openRecord(rec.id); loadCollections();
  } catch (e) { msg(e.message, "err"); }
}
async function migrateRecord(rec) {
  const c = parseContent();
  if (!c.ok) return msg(c.error, "err");
  try {
    await api("/records/" + encodeURIComponent(rec.id) + "/migrate", { method: "POST", body: JSON.stringify({
      content: c.value, author: document.getElementById("rauthor").value || undefined }) });
    msg("Migrated to current schema."); openRecord(rec.id);
  } catch (e) { msg(e.message, "err"); }
}
async function deleteRecord(id, hard) {
  if (!confirm(hard ? "Permanently delete this record and its history?" : "Soft-delete this record?")) return;
  try { await api("/records/" + encodeURIComponent(id) + "?hard=" + hard, { method: "DELETE" }); msg("Deleted."); renderList(); loadRecords(); loadCollections(); }
  catch (e) { msg(e.message, "err"); }
}
async function addComment(id) {
  const body = document.getElementById("cbody").value.trim();
  if (!body) return;
  try { await api("/records/" + encodeURIComponent(id) + "/comments", { method: "POST", body: JSON.stringify({ body, author: document.getElementById("cauthor").value || undefined }) }); openRecord(id); }
  catch (e) { msg(e.message, "err"); }
}

function openNewRecord() {
  document.getElementById("view").innerHTML =
    '<button class="link" id="back">← back</button><div class="card"><h2>New record</h2>' +
    "<label>collection</label><input id='ncol' value='" + esc(state.collection ?? "") + "' placeholder='collection name' />" +
    "<label>content (JSON)</label><textarea id='content'>{\\n  \\n}</textarea>" +
    "<label>source</label><input id='nsource' placeholder='https://… or file path' />" +
    "<label>tags (comma separated)</label><input id='ntags' />" +
    "<label>status</label><select id='nstatus'><option>draft</option><option>verified</option><option>rejected</option></select>" +
    "<label>author</label><input id='nauthor' placeholder='your agent id' />" +
    "<div style='margin-top:10px'><button class='primary' id='create'>Create</button></div></div>";
  document.getElementById("back").onclick = () => renderList();
  document.getElementById("create").onclick = async () => {
    const c = parseContent();
    if (!c.ok) return msg(c.error, "err");
    try {
      const rec = await api("/records", { method: "POST", body: JSON.stringify({
        collection: document.getElementById("ncol").value.trim(), content: c.value,
        source: document.getElementById("nsource").value || undefined,
        tags: document.getElementById("ntags").value.split(",").map((t) => t.trim()).filter(Boolean),
        status: document.getElementById("nstatus").value,
        author: document.getElementById("nauthor").value || undefined,
      }) });
      msg("Created."); loadCollections(); openRecord(rec.id);
    } catch (e) { msg(e.message, "err"); }
  };
}

function openNewCollection() {
  document.getElementById("view").innerHTML =
    '<button class="link" id="back">← back</button><div class="card"><h2>New collection</h2>' +
    "<label>name</label><input id='cname' placeholder='letters, numbers, . _ -' />" +
    "<label>description</label><input id='cdesc' />" +
    "<label>JSON Schema (optional)</label><textarea id='cschema' placeholder='Leave blank for free-form records'></textarea>" +
    "<div style='margin-top:10px'><button class='primary' id='create'>Create</button></div></div>";
  document.getElementById("back").onclick = () => renderList();
  document.getElementById("create").onclick = async () => {
    const raw = document.getElementById("cschema").value.trim();
    let schema;
    if (raw) { try { schema = JSON.parse(raw); } catch (e) { return msg("Schema is not valid JSON: " + e.message, "err"); } }
    try {
      await api("/collections", { method: "POST", body: JSON.stringify({
        name: document.getElementById("cname").value.trim(),
        description: document.getElementById("cdesc").value || undefined, schema }) });
      msg("Collection created."); await loadCollections();
      selectCollection(document.getElementById("cname").value.trim());
    } catch (e) { msg(e.message, "err"); }
  };
}

async function openSchema(name) {
  const { current, versions } = await api("/collections/" + encodeURIComponent(name) + "/schema");
  document.getElementById("view").innerHTML =
    '<button class="link" id="back">← back</button><div class="card"><h2>Schema · ' + esc(name) + "</h2>" +
    "<div class='muted'>Versions: " + (versions.length ? versions.join(", ") : "none — free-form") + "</div>" +
    "<label>JSON Schema (saving appends a new version)</label><textarea id='schema'></textarea>" +
    "<label>author</label><input id='sauthor' placeholder='your agent id' />" +
    "<div style='margin-top:10px'><button class='primary' id='save'>Save new version</button></div></div>";
  document.getElementById("schema").value = current ? JSON.stringify(current.schema, null, 2) : "{\\n  \\"type\\": \\"object\\",\\n  \\"properties\\": {}\\n}";
  document.getElementById("back").onclick = () => renderList();
  document.getElementById("save").onclick = async () => {
    let schema;
    try { schema = JSON.parse(document.getElementById("schema").value); } catch (e) { return msg("Not valid JSON: " + e.message, "err"); }
    try {
      await api("/collections/" + encodeURIComponent(name) + "/schema", { method: "PUT", body: JSON.stringify({ schema, author: document.getElementById("sauthor").value || undefined }) });
      msg("Schema version saved."); loadCollections(); openSchema(name);
    } catch (e) { msg(e.message, "err"); }
  };
}

document.getElementById("all-records").onclick = () => { state.collection = null; loadRecords(); loadCollections(); };
document.getElementById("newRec").onclick = openNewRecord;
document.getElementById("newCol").onclick = openNewCollection;
document.getElementById("setToken").onclick = () => { const t = prompt("Bearer token (blank to clear):", localStorage.getItem("curator_token") || ""); if (t === null) return; if (t) localStorage.setItem("curator_token", t); else localStorage.removeItem("curator_token"); msg("Token updated."); };

(async function init() {
  try { const h = await fetch("/health").then((r) => r.json()); document.getElementById("ver").textContent = "v" + h.version; } catch {}
  try { await loadCollections(); await loadRecords(); } catch (e) { msg(e.message, "err"); }
})();
</script>
</body>
</html>`;
