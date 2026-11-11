import { getStore } from "@netlify/blobs";

// One function, two jobs:
//   POST /inbox          the web page saves an analysis (needs x-inbox-secret header)
//   POST /mcp/<SECRET>   Claude reads the inbox through MCP (secret is part of the address)
export const config = { path: ["/inbox", "/playbook", "/mcp/*"] };

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const T = (text) => ({ content: [{ type: "text", text }] });
const keys = async (st) => (await st.list()).blobs.map((b) => b.key).sort().reverse();
const EMPTY = "The inbox is empty. Ask the user to run an analysis on the Gemini – Claude Connector page first.";

const PB_TOOLS = [
  { name: "list_playbook", description: "List the playbook notes (reusable editing techniques and learning notes). Shows each name, how many entries, last update, and how many are draft or verified.", inputSchema: { type: "object", properties: {} } },
  { name: "get_playbook", description: "Read one playbook note by name. Entries marked draft were written by Gemini and are not verified, so treat them as unconfirmed until checked.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Playbook name from list_playbook." } }, required: ["name"] } },
  { name: "save_playbook", description: "Save or update a playbook note. Mode append adds a new entry (default). Mode replace overwrites the note, for example to save a cleaned-up master version. Use status verified only for notes checked against measurements or the user's own research; otherwise draft.", inputSchema: { type: "object", properties: { name: { type: "string" }, text: { type: "string" }, mode: { type: "string", enum: ["append", "replace"] }, status: { type: "string", enum: ["draft", "verified", "user"] } }, required: ["name", "text"] } },
  { name: "delete_playbook", description: "Delete a whole playbook note by name.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];
const TOOLS = [
  ...PB_TOOLS,
  { name: "get_analysis", description: "Get a video analysis the user sent from the Gemini – Claude Connector page. Returns the newest one unless an id is given.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Analysis id from list_analyses. Omit for the newest." } } } },
  { name: "list_analyses", description: "List recent video analyses in the inbox, newest first.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many to list (default 10, max 30)." } } } },
  { name: "delete_analysis", description: "Delete one analysis from the inbox by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
async function addNote(name, text, source, status, mode) {
  const id = slug(name);
  if (!id) throw new Error("A name is required."); to
  const st = getStore("playbook");
  const old = (await st.get(id, { type: "json" })) || { name: id, entries: [] };
  const entry = { t: Date.now(), source: String(source || "").slice(0, 120), status: ["draft", "verified", "user"].includes(status) ? status : "draft", text: String(text).slice(0, 300000) };
  old.entries = mode === "replace" ? [entry] : [...old.entries, entry].slice(-20);
  old.updated = Date.now();
  await st.setJSON(id, old);
  return { slug: id, count: old.entries.length };
}
async function pbTool(name, a) {
  const st = getStore("playbook");
  if (name === "list_playbook") {
    const ks = (await st.list()).blobs.map((b) => b.key).sort();
    if (!ks.length) return T("The playbook is empty. Notes arrive when the user adds #playbook to the extra instructions on the connector page, or when Claude saves one.");
    const rows = [];
    for (const k of ks) {
      const x = await st.get(k, { type: "json" }); if (!x) continue;
      const c = {}; x.entries.forEach((e) => (c[e.status] = (c[e.status] || 0) + 1));
      rows.push(`${k} | ${x.entries.length} entries | updated ${new Date(x.updated).toISOString().slice(0, 10)} | ${Object.entries(c).map(([s, n]) => s + " " + n).join(", ")} | ${x.entries.reduce((n, e) => n + e.text.length, 0)} chars`);
    }
    return T(rows.join("\n"));
  }
  if (name === "get_playbook") {
    const x = await st.get(slug(a.name), { type: "json" });
    if (!x) return { ...T(`No playbook named "${a.name}". Use list_playbook to see the names.`), isError: true };
    return T(x.entries.map((e, i) => `### Entry ${i + 1} · ${new Date(e.t).toISOString().slice(0, 10)} · ${e.status} · ${e.source}\n${e.text}`).join("\n\n"));
  }
  if (name === "save_playbook") {
    if (!a.text) return { ...T("Text is required."), isError: true };
    const r = await addNote(a.name, a.text, "claude", a.status || "draft", a.mode);
    return T(`Saved to playbook "${r.slug}" (${r.count} entries).`);
  }
  if (name === "delete_playbook") { await st.delete(slug(a.name)); return T("Deleted playbook " + slug(a.name)); }
  return { ...T("Unknown tool: " + name), isError: true };
}
async function callTool(name, a = {}) {
  if (name.endsWith("_playbook")) return pbTool(name, a);
  const st = getStore("analyses");
  if (name === "list_analyses") {
    const ks = (await keys(st)).slice(0, Math.min(Number(a.limit) || 10, 30));
    if (!ks.length) return T(EMPTY);
    const rows = [];
    for (const k of ks) {
      const x = await st.get(k, { type: "json" });
      if (x) rows.push(`${x.id} | ${new Date(x.t).toISOString()} | ${x.name} | ${x.focus} | ${x.text.length} chars`);
    }
    return T(rows.join("\n"));
  }
  if (name === "get_analysis") {
    const id = a.id || (await keys(st))[0];
    if (!id) return T(EMPTY);
    const x = await st.get(id, { type: "json" });
    return x ? T(x.text) : { ...T("No analysis with that id."), isError: true };
  }
  if (name === "delete_analysis") {
    if (!a.id) return { ...T("An id is required."), isError: true };
    await st.delete(a.id);
    return T("Deleted " + a.id);
  }
  return { ...T("Unknown tool: " + name), isError: true };
}

async function rpc(m) {
  if (m.id === undefined) return null; // notification, no reply
  const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  const no = (code, message) => ({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  try {
    switch (m.method) {
      case "initialize":
        return ok({ protocolVersion: m.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "gemini-claude-inbox", version: "1.0.0" } });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": return ok(await callTool(m.params?.name, m.params?.arguments));
      default: return no(-32601, "Method not found");
    }
  } catch (e) { return no(-32603, String(e.message || e)); }
}

export default async (req) => {
  const S = Netlify.env.get("INBOX_SECRET");
  if (!S) return J({ error: "Set the INBOX_SECRET environment variable in Netlify." }, 500);
  const { pathname } = new URL(req.url);

  if (pathname === "/inbox") {
    if (req.method !== "POST") return J({ error: "POST only" }, 405);
    if (req.headers.get("x-inbox-secret") !== S) return J({ error: "Wrong secret" }, 401);
    let b; try { b = await req.json(); } catch { return J({ error: "Bad JSON" }, 400); }
    if (typeof b.text !== "string" || !b.text || b.text.length > 1.5e6) return J({ error: "Missing or too large" }, 400);
    const st = getStore("analyses");
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    await st.setJSON(id, { id, t: Date.now(), name: String(b.name || "video").slice(0, 120), model: String(b.model || ""), focus: String(b.focus || ""), text: b.text });
    for (const k of (await keys(st)).slice(30)) await st.delete(k); // keep the newest 30
    return J({ ok: true, id });
  }

  if (pathname === "/playbook") {
    if (req.method !== "POST") return J({ error: "POST only" }, 405);
    if (req.headers.get("x-inbox-secret") !== S) return J({ error: "Wrong secret" }, 401);
    let b; try { b = await req.json(); } catch { return J({ error: "Bad JSON" }, 400); }
    if (typeof b.text !== "string" || !b.text || b.text.length > 300000 || !slug(b.name)) return J({ error: "Need a name and text (max 300000 characters)" }, 400);
    return J({ ok: true, ...(await addNote(b.name, b.text, b.source || "page", "draft", b.mode)) }); // the page can only write drafts
  }
  const given = decodeURIComponent(pathname.replace(/^\/mcp\//, "").replace(/\/$/, ""));
  if (given !== S) return J({ error: "Not found" }, 404);
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  let body; try { body = await req.json(); } catch { return J({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) {
    const r = (await Promise.all(body.map(rpc))).filter(Boolean);
    return r.length ? J(r) : new Response(null, { status: 202 });
  }
  const r = await rpc(body);
  return r ? J(r) : new Response(null, { status: 202 });
};
