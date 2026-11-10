const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors, ...headers }
  });
}

const columns = "shortcut,name,version,description,download,updated,metadata_json";

function publicShortcut(row) {
  let metadata = {};
  try {
    const parsed = JSON.parse(row.metadata_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {}
  return {
    ...metadata,
    id: row.shortcut,
    shortcut: row.shortcut,
    name: row.name,
    version: row.version,
    description: row.description,
    download: row.download,
    updated: row.updated
  };
}

async function readJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) return JSON.parse("");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new RangeError("Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

const help = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shortcuts+ Registry API</title><style>body{font:16px system-ui;max-width:760px;margin:10vh auto;padding:0 24px;line-height:1.6;color:#202124}pre{background:#f2f3f5;border-radius:8px;padding:16px;overflow:auto}h1{letter-spacing:-.04em}</style></head><body><h1>Shortcuts+ Registry API</h1><p>Public information about Apple Shortcuts.</p><h2>GET /all</h2><p>Returns every active shortcut in the <code>shortcuts</code> array.</p><h2>POST /details</h2><pre>{"details":"version","shortcut":"webportal-plus"}</pre><p>Use <code>"details":"all"</code> for all available information. <code>/detail</code> is an alias.</p><h2>POST /</h2><pre>{"shortcut":"webportal-plus"}</pre><p>Existing shortcut lookups remain supported. Unknown or inactive shortcuts return a 404 JSON response.</p></body></html>`;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && path === "/") {
      return new Response(help, { headers: { "Content-Type": "text/html; charset=utf-8", ...cors } });
    }
    if (request.method === "GET" && path === "/health") return json({ success: true, service: "shortcuts-registry" });

    try {
      if (path === "/all" && (request.method === "GET" || request.method === "POST")) {
        const { results } = await env.DB.prepare(`SELECT ${columns} FROM shortcuts WHERE active=1 ORDER BY shortcut`).all();
        return json({ success: true, shortcuts: results.map(publicShortcut) });
      }
      if (request.method !== "POST") {
        return json({ success: false, error: "method_not_allowed", message: "Use GET /all or POST with a JSON body." }, 405, { Allow: path === "/all" ? "GET, POST, OPTIONS" : "POST, OPTIONS" });
      }
      if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        return json({ success: false, error: "unsupported_media_type", message: "Content-Type must be application/json." }, 415);
      }
      let body;
      try {
        body = await readJSON(request);
      } catch (error) {
        const tooLarge = error instanceof RangeError;
        return json({ success: false, error: tooLarge ? "request_too_large" : "invalid_json", message: tooLarge ? "Request body must not exceed 4096 bytes." : "Request body must contain valid JSON." }, tooLarge ? 413 : 400);
      }
      if (!body || typeof body.shortcut !== "string" || !body.shortcut.trim()) {
        return json({ success: false, error: "missing_shortcut", message: 'A non-empty "shortcut" string is required.' }, 400);
      }
      const shortcut = body.shortcut.trim();
      if (shortcut.length > 120) return json({ success: false, error: "invalid_shortcut", message: "Shortcut identifier is too long." }, 400);
      const details = body.details ?? "all";
      if (details !== "all" && details !== "version") {
        return json({ success: false, error: "invalid_details", message: 'Use "details":"all" or "details":"version".' }, 400);
      }
      const row = await env.DB.prepare(`SELECT ${columns} FROM shortcuts WHERE shortcut=? AND active=1`).bind(shortcut).first();
      if (!row) return json({ success: false, error: "shortcut_not_found", shortcut, message: "No active shortcut matches that identifier." }, 404);
      return details === "version"
        ? json({ success: true, shortcut: row.shortcut, version: row.version })
        : json({ ...publicShortcut(row), success: true });
    } catch {
      console.error(JSON.stringify({ event: "registry_database_error", path }));
      return json({ success: false, error: "database_error", message: "The registry could not complete the lookup." }, 500);
    }
  }
};
