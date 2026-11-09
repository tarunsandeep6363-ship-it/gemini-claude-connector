import { getStore } from "@netlify/blobs";

// One function, two jobs:
//   POST /inbox          the web page saves an analysis (needs x-inbox-secret header)
//   POST /mcp/<SECRET>   Claude reads the inbox through MCP (secret is part of the address)
export const config = { path: ["/inbox", "/mcp/*"] };

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const T = (text) => ({ content: [{ type: "text", text }] });
const keys = async (st) => (await st.list()).blobs.map((b) => b.key).sort().reverse();
const EMPTY = "The inbox is empty. Ask the user to run an analysis on the Gemini – Claude Connector page first.";

const TOOLS = [
  { name: "get_analysis", description: "Get a video analysis the user sent from the Gemini – Claude Connector page. Returns the newest one unless an id is given.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Analysis id from list_analyses. Omit for the newest." } } } },
  { name: "list_analyses", description: "List recent video analyses in the inbox, newest first.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many to list (default 10, max 30)." } } } },
  { name: "delete_analysis", description: "Delete one analysis from the inbox by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

async function callTool(name, a = {}) {
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
