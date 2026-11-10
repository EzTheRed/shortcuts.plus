const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSETS = 24;
const MAX_REDIRECTS = 5;
const TRANSPARENT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const API_IDS = Object.freeze({ GET_WEBSITE: "get-website", VCF_MENU: "vcf-menu" });

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "x-content-type-options": "nosniff"
    }
  });
}


async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeBasicToken(request, env, apiId, tokenType = "SHORTCUT") {
  if (!env.AUTH_DB) return false;
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
  if (!match) return false;
  let decoded;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) return false;
  const suppliedApiId = decoded.slice(0, separator);
  const token = decoded.slice(separator + 1);
  if (suppliedApiId !== apiId || !token) return false;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  try {
    const consumed = await env.AUTH_DB.prepare(
      "UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND scope = ? AND token_type = ? AND expires_at > ? AND used_at IS NULL AND revoked = 0 RETURNING id"
    ).bind(now, tokenHash, apiId, tokenType, now).first();
    return Boolean(consumed);
  } catch {
    return false;
  }
}


async function issuePublicBasicToken(env, apiId) {
  if (!env.AUTH_DB) throw new Error("Token storage is unavailable.");
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const token = [...random].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 10;
  const id = crypto.randomUUID();
  await env.AUTH_DB.prepare("INSERT INTO auth_tokens (id, token_hash, name, identity_email, scope, issued_at, expires_at, token_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, tokenHash, apiId, "public", apiId, now, expiresAt, "SHORTCUT").run();
  return "Basic " + btoa(apiId + ":" + token);
}
function isPrivateOrLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid") ||
      host.endsWith(".example")) return true;
  if (host.includes(":")) {
    return host === "::" || host === "::1" || host.startsWith("fc") ||
      host.startsWith("fd") || /^fe[89ab]/i.test(host) || host.startsWith("::ffff:");
  }
  if (/^[0-9.]+$/.test(host)) {
    const p = host.split(".").map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  return false;
}

function validateTarget(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) {
    throw new Error("Provide a webpage URL no longer than 2048 characters.");
  }
  let u;
  try { u = new URL(value); } catch { throw new Error("The supplied URL is not valid."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (u.username || u.password) throw new Error("URLs containing usernames or passwords are not allowed.");
  if (isPrivateOrLocalHost(u.hostname)) throw new Error("Local, private, and reserved network addresses are not allowed.");
  u.hash = "";
  return u;
}

function makeContext() {
  return { assets: 0, bytes: 0, skipped: [] };
}

async function fetchResource(startUrl, context, kind) {
  let target = validateTarget(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(target.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: kind === "css" ? "text/css,*/*;q=0.1" :
          kind === "js" ? "text/javascript,application/javascript,*/*;q=0.1" : "*/*;q=0.1",
        "user-agent": "ShortcutsPlus-PagePackager/1.0"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) throw new Error("A remote resource redirected without a destination.");
      if (i === MAX_REDIRECTS) throw new Error("A remote resource redirected too many times.");
      target = validateTarget(new URL(loc, target).href);
      continue;
    }
    if (!response.ok) throw new Error("Resource fetch returned HTTP " + response.status + ".");
    const len = Number(response.headers.get("content-length") || 0);
    if (len > MAX_ASSET_BYTES) throw new Error("A resource exceeded the 1 MB size limit.");
    const text = await response.text();
    const size = new TextEncoder().encode(text).byteLength;
    if (size > MAX_ASSET_BYTES) throw new Error("A resource exceeded the 1 MB size limit.");
    context.assets++;
    context.bytes += size;
    if (context.assets > MAX_ASSETS) throw new Error("The page references more than 24 external CSS/JS resources.");
    if (context.bytes > MAX_TOTAL_ASSET_BYTES) throw new Error("External CSS/JS resources exceed the 4 MB total limit.");
    return { text, url: target.href, contentType: response.headers.get("content-type") || "" };
  }
  throw new Error("Unable to fetch remote resource.");
}

function absoluteCssUrls(css, stylesheetUrl) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, quote, raw) => {
    const value = raw.trim();
    if (!value || /^(data:|blob:|#|about:)/i.test(value)) return all;
    try {
      const absolute = new URL(value, stylesheetUrl);
      if (!["http:", "https:"].includes(absolute.protocol)) return all;
      return 'url("' + absolute.href.replace(/"/g, "%22") + '")';
    } catch { return all; }
  });
}

async function inlineCssImports(css, stylesheetUrl, context, depth = 0) {
  if (depth >= 3) return absoluteCssUrls(css, stylesheetUrl);
  const importPattern = /@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?[^;]*;/gi;
  let output = "";
  let last = 0;
  for (const match of css.matchAll(importPattern)) {
    output += css.slice(last, match.index);
    last = match.index + match[0].length;
    try {
      const importUrl = new URL(match[2], stylesheetUrl);
      const fetched = await fetchResource(importUrl.href, context, "css");
      if (!/text\/css/i.test(fetched.contentType)) throw new Error("Imported resource is not CSS.");
      output += "\n/* Inlined @import: " + fetched.url.replace(/\*\//g, "") + " */\n";
      output += await inlineCssImports(fetched.text, fetched.url, context, depth + 1);
    } catch (error) {
      context.skipped.push({ type: "css-import", url: match[2], reason: error.message });
      output += match[0];
    }
  }
  output += css.slice(last);
  return absoluteCssUrls(output, stylesheetUrl);
}

function safeInlineText(value, closingTag) {
  return value.replace(new RegExp("</" + closingTag, "gi"), "<\/" + closingTag);
}

async function packageHtml(sourceHtml, pageUrl) {
  const context = makeContext();
  let html = sourceHtml;

  // Inline linked stylesheets.
  const linkPattern = /<link\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>/gi;
  const linkMatches = [...html.matchAll(linkPattern)];
  for (const match of linkMatches) {
    const attrs = match[1] + " " + match[4];
    if (!/\brel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(attrs)) continue;
    const original = match[0];
    try {
      const resourceUrl = new URL(match[3], pageUrl);
      const fetched = await fetchResource(resourceUrl.href, context, "css");
      if (!/text\/css/i.test(fetched.contentType)) throw new Error("Linked resource is not CSS.");
      const css = await inlineCssImports(fetched.text, fetched.url, context);
      const replacement = "<style data-inlined-from=\"" + fetched.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + "\">\n" +
        safeInlineText(css, "style") + "\n</style>";
      html = html.replace(original, replacement);
    } catch (error) {
      context.skipped.push({ type: "stylesheet", url: match[3], reason: error.message });
    }
  }

  // Inline external classic and module scripts. Module imports that are relative
  // continue to resolve against the injected base URL.
  const scriptPattern = /<script\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script\s*>/gi;
  const scriptMatches = [...html.matchAll(scriptPattern)];
  for (const match of scriptMatches) {
    const original = match[0];
    try {
      const resourceUrl = new URL(match[3], pageUrl);
      const fetched = await fetchResource(resourceUrl.href, context, "js");
      if (!/(javascript|ecmascript|text\/plain)/i.test(fetched.contentType)) {
        throw new Error("Linked resource did not return JavaScript.");
      }
      const replacement = "<script" + match[1] + match[4] + " data-inlined-from=\"" +
        fetched.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + "\">\n" +
        safeInlineText(fetched.text, "script") + "\n</script>";
      html = html.replace(original, replacement);
    } catch (error) {
      context.skipped.push({ type: "script", url: match[3], reason: error.message });
    }
  }

  // Resolve URLs inside inline style attributes and style blocks.
  html = html.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (all, q, css) => {
    return "style=" + q + absoluteCssUrls(css, pageUrl).replace(new RegExp(q, "g"), q === '"' ? "&quot;" : "&#39;") + q;
  });
  const stylePattern = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
  html = html.replace(stylePattern, (all, open, css, close) =>
    open + safeInlineText(absoluteCssUrls(css, pageUrl), "style") + close
  );

  const safeBase = pageUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const baseTag = '<base href="' + safeBase + '">';
  html = html.replace(/<base\b[^>]*>/i, "");
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, head => head + "\n" + baseTag);
  else html = baseTag + "\n" + html;

  return { html, context };
}

async function fetchPage(startUrl) {
  let target = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    target = validateTarget(target.href);
    const response = await fetch(target.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": "ShortcutsPlus-PagePackager/1.0"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) throw new Error("The website redirected without a destination.");
      if (i === MAX_REDIRECTS) throw new Error("The website redirected too many times.");
      target = validateTarget(new URL(loc, target).href);
      continue;
    }
    if (!response.ok) throw new Error("The website returned HTTP " + response.status + ".");
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) {
      throw new Error("The URL did not return an HTML webpage.");
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_HTML_BYTES) throw new Error("The webpage exceeds the 2 MB HTML limit.");
    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("The webpage exceeds the 2 MB HTML limit.");
    return { html, finalUrl: target.href };
  }
  throw new Error("Unable to retrieve the webpage.");
}


function pageCacheKey(url) {
  const key = new URL("https://api.shortcuts.plus/__html-page-cache-v1");
  key.searchParams.set("url", validateTarget(url).href);
  return new Request(key.href, { method: "GET" });
}



function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function renderShortcutsPlusPage(env) {
  const dataUrl = "https://shortcuts.plus/data/shortcuts.json";
  const context = makeContext();
  const fetched = await fetchResource(dataUrl, context, "js");
  if (!/json/i.test(fetched.contentType)) throw new Error("The shortcuts data endpoint did not return JSON.");

  let records;
  try { records = JSON.parse(fetched.text); }
  catch { throw new Error("The shortcuts data file contains invalid JSON."); }
  if (!Array.isArray(records)) throw new Error("The shortcuts data file must contain an array.");

  const entries = [];
  // Resolve the same registry IDs as the browser, without truncating the catalog.
  // Small batches limit simultaneous upstream connections.
  for (let offset = 0; offset < records.length; offset += 6) {
    const batch = await Promise.all(records.slice(offset, offset + 6).map(async (item, index) => {
      if (!item || typeof item.title !== "string") return null;
      const jsonIndex = offset + index;
      let resolved = item;
      if (typeof item.id === "string" && item.id) {
        try {
          const registryUrl = "https://s.shortcuts.plus/";
          const options = {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ shortcut: item.id })
          };
          // Same-zone routed Workers must communicate through a service binding.
          const response = env.REGISTRY
            ? await env.REGISTRY.fetch(new Request(registryUrl, options))
            : await fetch(registryUrl, options);
          const data = await response.json();
          if (response.ok && data.success) resolved = {
            ...item, title: data.name || item.title,
            desc: data.description || item.desc, link: data.download || item.link
          };
        } catch {
          // Keep the catalog entry visible even if the registry is unavailable.
        }
      }
      let safeLink = "https://shortcuts.plus/full.html?s=" + jsonIndex;
      let downloadable = false;
      try {
        const parsed = new URL(resolved.link);
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
          safeLink = parsed.href;
          downloadable = true;
        }
      } catch {}
      return { ...resolved, safeLink, downloadable };
    }));
    entries.push(...batch.filter(Boolean));
  }

  const cards = entries.map((item, index) => {
    const categories = Array.isArray(item.category) ? item.category.filter(x => typeof x === "string") : [];
    return '<article class="project-card"><div class="card-top"><span class="app-icon" aria-hidden="true">✦</span><span class="card-index">' +
      String(index + 1).padStart(2, "0") + '</span></div><h2>' + escapeHtml(item.title) +
      '</h2><p class="card-description">' + escapeHtml(item.desc || "A shortcut made for the Shortcuts app.") +
      '</p><div class="chips">' + categories.map(value => '<span class="chip">' + escapeHtml(value) + '</span>').join("") +
      '</div><a class="project-link" aria-label="' + escapeHtml(item.title) + '" href="' + escapeHtml(item.safeLink) + '">' +
      (item.downloadable ? 'Get shortcut' : 'View details') + ' <span aria-hidden="true">↗</span></a></article>';
  }).join("");

  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark"><title>Shortcuts+ — All Shortcuts</title>',
    '<style>',
    ':root{color-scheme:light dark;--bg:#fff;--panel:#f5f5f7;--ink:#1d1d1f;--muted:#6e6e73;--accent:#0066cc;--line:#d2d2d7}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--accent)}a:focus-visible{outline:3px solid var(--accent);outline-offset:5px}',
    '.page{width:min(1024px,100% - 48px);margin:auto}.nav{display:flex;align-items:center;justify-content:space-between;min-height:64px;border-bottom:1px solid var(--line)}.brand{color:var(--ink);font-size:21px;font-weight:600;text-decoration:none;letter-spacing:-.8px}.brand span{color:var(--accent)}.nav-label{font-size:12px;color:var(--muted)}',
    '.hero{text-align:center;padding:88px 0 72px}.eyebrow{margin:0 0 18px;font-size:14px;font-weight:600;color:var(--muted)}h1{margin:0;font-size:clamp(44px,8vw,80px);line-height:1.05;letter-spacing:-.055em;font-weight:700}h1 span{color:var(--muted)}.intro{max-width:540px;margin:24px auto 0;font-size:21px;line-height:1.45;color:var(--muted)}',
    '.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:0 0 24px}.section-head h2{font-size:28px;letter-spacing:-1px;margin:0}.count{color:var(--muted);font-size:13px}.projects{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}',
    '.project-card{min-width:0;background:var(--panel);border-radius:28px;padding:32px;display:flex;flex-direction:column;align-items:flex-start}.card-top{display:flex;align-items:center;justify-content:space-between;width:100%}.app-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:15px;background:var(--accent);color:white;font-size:28px}.card-index{font-size:12px;color:var(--muted)}.project-card h2{font-size:28px;letter-spacing:-1px;line-height:1.2;margin:24px 0 12px;overflow-wrap:anywhere}.card-description{color:var(--muted);margin:0 0 20px;overflow-wrap:anywhere}.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:28px}.chip{color:var(--muted);font-size:12px}.chip+.chip:before{content:"·";margin-right:8px}.project-link{display:inline-block;margin-top:auto;border-radius:999px;padding:10px 19px;background:var(--accent);color:white;text-decoration:none;font-size:14px}',
    'footer{margin-top:72px;padding:24px 0 32px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}@media(max-width:600px){.page{width:calc(100% - 32px)}.hero{padding:60px 0 48px}.intro{font-size:19px}.projects{grid-template-columns:1fr;gap:16px}.project-card{padding:26px}.section-head h2{font-size:24px}}',
    '@media(prefers-color-scheme:dark){:root{--bg:#000;--panel:#1c1c1e;--ink:#f5f5f7;--muted:#a1a1a6;--accent:#2997ff;--line:#424245}.project-link{background:#0071e3}}',
    '</style></head><body><main class="page">',
    '<nav class="nav"><a class="brand" href="https://shortcuts.plus/">Shortcuts<span>+</span></a><span class="nav-label">Made for Apple Shortcuts</span></nav>',
    '<header class="hero"><p class="eyebrow">Shortcuts+</p><h1>Small shortcuts.<br><span>More possibilities.</span></h1><p class="intro">Thoughtful tools for the things you do every day. Built for Apple Shortcuts.</p></header>',
    '<section aria-label="All shortcuts"><div class="section-head"><h2>Explore the collection.</h2><span class="count">' + entries.length + ' shortcut' + (entries.length === 1 ? '' : 's') + '</span></div><div class="projects">' + cards + '</div></section>',
    '<footer>Shortcuts+ is independent and is not affiliated with Apple Inc. Review a shortcut’s actions and permissions before running it.</footer>',
    '</main></body></html>'
  ].join("\n");

  return html;
}

function parseAssignedJson(html, variableName) {
  let searchFrom = 0;
  while (true) {
    const at = html.indexOf(variableName, searchFrom);
    if (at < 0) return null;
    searchFrom = at + variableName.length;
    const equals = html.indexOf("=", at + variableName.length);
    if (equals < 0 || equals - at > 80) continue;
    let start = equals + 1;
    while (/\s/.test(html[start] || "")) start++;
    if (html[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const char = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
}

function youtubeText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.simpleText === "string") return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map(run => run?.text || "").join("");
  return "";
}

function extractYouTubeVideos(html, pageUrl) {
  const initial = parseAssignedJson(html, "ytInitialData");
  if (!initial) return [];
  const videos = [];
  const seen = new Set();
  const rendererKeys = ["videoRenderer", "gridVideoRenderer", "compactVideoRenderer", "playlistVideoRenderer"];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    for (const key of rendererKeys) {
      const item = value[key];
      if (!item || typeof item !== "object") continue;
      const videoId = typeof item.videoId === "string" ? item.videoId : "";
      const title = youtubeText(item.title);
      if (!videoId || !title || seen.has(videoId)) continue;
      seen.add(videoId);

      const rawThumbs = Array.isArray(item.thumbnail?.thumbnails) ? item.thumbnail.thumbnails : [];
      let thumbnail = "";
      for (const candidate of rawThumbs.slice().reverse()) {
        try {
          const parsed = new URL(candidate.url, "https://www.youtube.com");
          if (parsed.protocol === "https:" &&
              (parsed.hostname === "i.ytimg.com" || parsed.hostname.endsWith(".ytimg.com") ||
               parsed.hostname.endsWith(".googleusercontent.com"))) {
            thumbnail = parsed.href;
            break;
          }
        } catch {}
      }

      const endpoint = item.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
      let href = "/watch?v=" + encodeURIComponent(videoId);
      if (typeof endpoint === "string" && endpoint.startsWith("/")) href = endpoint;
      const target = new URL(href, pageUrl).href;
      const owner = youtubeText(item.ownerText) || youtubeText(item.shortBylineText) ||
        youtubeText(item.longBylineText) || youtubeText(item.channelName);
      const views = youtubeText(item.viewCountText) || youtubeText(item.shortViewCountText);
      const published = youtubeText(item.publishedTimeText);
      const duration = youtubeText(item.lengthText);
      videos.push({ videoId, title, thumbnail, target, owner, views, published, duration });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(initial);
  return videos.slice(0, 48);
}

function renderYouTubeFeed(videos, pageUrl) {
  const cards = videos.map(video => {
    const image = video.thumbnail
      ? '<img class="thumb" src="' + escapeHtml(video.thumbnail) + '" alt="" referrerpolicy="no-referrer">'
      : '<div class="thumb placeholder">YouTube</div>';
    const details = [video.owner, video.views, video.published, video.duration]
      .filter(Boolean).map(escapeHtml).join(" · ");
    return '<a class="video" href="' + escapeHtml(video.target) + '">' + image +
      '<div class="info"><h2>' + escapeHtml(video.title) + '</h2>' +
      (details ? '<p>' + details + '</p>' : '') + '</div></a>';
  }).join("");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>YouTube — Static Feed</title>' +
    '<style>' +
    '*{box-sizing:border-box}body{margin:0;background:#fff;color:#0f0f0f;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    'header{padding:18px 16px;border-bottom:1px solid #e5e5e5;display:flex;align-items:center;gap:10px;font-weight:750;font-size:19px}' +
    '.mark{width:28px;height:20px;border-radius:6px;background:#e62117;display:grid;place-items:center;color:white;font-size:12px}' +
    'main{max-width:920px;margin:0 auto;padding:14px 12px 30px}.notice{font-size:12px;color:#606060;margin:4px 4px 16px}' +
    '.feed{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:22px 16px}' +
    '.video{color:inherit;text-decoration:none;min-width:0}.thumb{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#eee;border-radius:10px}' +
    '.placeholder{display:grid;place-items:center;color:#777}.info{padding:9px 2px}.info h2{font-size:15px;line-height:1.35;font-weight:650;margin:0 0 6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
    '.info p{font-size:12px;color:#606060;margin:0;line-height:1.5}.footer{margin-top:25px;padding-top:14px;border-top:1px solid #eee;color:#777;font-size:11px}' +
    '@media(prefers-color-scheme:dark){body{background:#0f0f0f;color:#f1f1f1}header{border-color:#333}.thumb{background:#272727}.info p,.notice,.footer{color:#aaa}.footer{border-color:#333}}' +
    '</style></head><body><header><span class="mark">▶</span>YouTube</header><main>' +
    '<p class="notice">Static feed preview · ' + videos.length + ' videos detected</p>' +
    '<section class="feed">' + cards + '</section><div class="footer">Video details are taken from the page’s publicly available embedded data. Open a video link to continue on YouTube.</div>' +
    '</main></body></html>';
}

function htmlFileResponse(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": 'attachment; filename="webpage.html"',
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-expose-headers": "Content-Disposition",
      "x-content-type-options": "nosniff"
    }
  });
}

async function buildPage(url, env) {
  const target = validateTarget(url).href;
  const cache = caches.default;
  const key = pageCacheKey(target);
  const cached = await cache.match(key);
  if (cached) return cached.text();

  const fetched = await fetchPage(validateTarget(target));
  const final = new URL(fetched.finalUrl);
  const isShortcutsPlusHome =
    (final.hostname.toLowerCase() === "shortcuts.plus" || final.hostname.toLowerCase() === "www.shortcuts.plus") &&
    final.pathname === "/" && !final.search;

  let html;
  if (isShortcutsPlusHome) {
    html = await renderShortcutsPlusPage(env);
  } else {
    const videos = /(^|\.)youtube\.com$/i.test(final.hostname)
      ? extractYouTubeVideos(fetched.html, fetched.finalUrl)
      : [];
    html = videos.length
      ? renderYouTubeFeed(videos, fetched.finalUrl)
      : (await packageHtml(fetched.html, fetched.finalUrl)).html;
  }

  await cache.put(key, new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=180"
    }
  }));
  return html;
}


function escapeVCard(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldVCardLine(line) {
  const encoder = new TextEncoder();
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      chunks.push(current);
      current = " " + char;
      bytes = 1 + size;
    } else {
      current += char;
      bytes += size;
    }
  }
  chunks.push(current);
  return chunks.join("\r\n");
}

function vcardResponse(items) {
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return json({ error: "Send a JSON object whose property names are contact titles and whose string values are subtitles." }, 400);
  }
  const entries = Object.entries(items);
  if (entries.length < 1 || entries.length > 100) {
    return json({ error: "Provide between 1 and 100 contacts." }, 400);
  }
  const cards = [];
  for (let i = 0; i < entries.length; i++) {
    const [rawTitle, rawSubtitle] = entries[i];
    if (!rawTitle.trim() || typeof rawSubtitle !== "string") {
      return json({ error: "Each property must have a non-empty title and a string subtitle.", item: i }, 400);
    }
    const title = escapeVCard(rawTitle.trim());
    const subtitle = escapeVCard(rawSubtitle);
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N;CHARSET=UTF-8:;" + title + ";;;",
      "ORG;CHARSET=UTF-8:" + subtitle,
      "PHOTO;ENCODING=b;TYPE=PNG:" + TRANSPARENT_PNG_BASE64,
      "FN;CHARSET=UTF-8:" + title,
      "NOTE;CHARSET=UTF-8:item_" + (i + 1),
      "UID:urn:uuid:" + crypto.randomUUID(),
      "END:VCARD"
    ];
    cards.push(lines.map(foldVCardLine).join("\r\n"));
  }
  return new Response(cards.join("\r\n\r\n") + "\r\n", {
    status: 200,
    headers: {
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": 'attachment; filename="shortcuts-menu.vcf"',
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "x-content-type-options": "nosniff"
    }
  });
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-max-age": "86400"
      }});
    }

    if (url.hostname.toLowerCase() === "api.shortcuts.plus" && url.pathname === "/api") {
      if (request.method !== "GET") {
        return new Response("GET only", { status: 405, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const directory = [
        "POST https://api.shortcuts.plus/auth",
        "POST https://api.shortcuts.plus/get-website",
        "POST https://api.shortcuts.plus/vcf-menu"
      ];
      return new Response("[\n  " + directory.map(path => JSON.stringify(path)).join(",\n  ") + "\n]", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (url.pathname === "/auth") {
      if (request.method !== "POST") return json({ error: "Use POST with a JSON body containing api." }, 405);
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 2048) return json({ error: "Request body is too large." }, 413);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }
      const api = typeof body?.api === "string" ? body.api.trim() : "";
      const apiIds = { "get-website": API_IDS.GET_WEBSITE, "vcf-menu": API_IDS.VCF_MENU };
      if (!Object.prototype.hasOwnProperty.call(apiIds, api)) return json({ error: "api must be get-website or vcf-menu." }, 400);
      try {
        const authorization = await issuePublicBasicToken(env, apiIds[api]);
        return new Response(authorization, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "x-content-type-options": "nosniff" }});
      } catch { return json({ error: "Unable to issue a token right now." }, 503); }
    }

    if (url.pathname === "/get-website" || url.pathname === "/vcf-menu") {
      if (request.method !== "POST") return json({ error: "Use POST with a JSON request body for this endpoint." }, 405);
      const apiId = url.pathname === "/get-website" ? API_IDS.GET_WEBSITE : API_IDS.VCF_MENU;
      const valid = await consumeBasicToken(request, env, apiId);
      if (!valid) return json({ error: "A valid, unused, unexpired Basic authentication token for this API is required." }, 401);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Shortcuts Plus Website API",
        status: "ok",
        endpoints: {
          auth: "POST /auth with JSON {api}; returns a short-lived API-ID-bound Basic token (get-website or vcf-menu)",
          website: "POST /get-website with JSON { url: <public-http-or-https-url> } (Basic token required)",
          vcfMenu: "POST /vcf-menu with a JSON object mapping contact titles to subtitles (Basic token required)"
        },
        response: "Packaged HTML file (text/html; attachment filename: webpage.html)"
      });
    }


    if (url.pathname === "/vcf-menu") {
      if (request.method !== "POST") return json({ error: "Use POST with a JSON object mapping contact titles to subtitles." }, 405);
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 16000) return json({ error: "The JSON request body is too large." }, 413);
      let data;
      try { data = await request.json(); }
      catch { return json({ error: "Request body must be valid JSON." }, 400); }
      return vcardResponse(data);
    }

    if (url.pathname === "/get-website") {
      if (request.method !== "POST") return json({ error: "Use POST with JSON { url: <public-http-or-https-url> }." }, 405);
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 8192) return json({ error: "The JSON request body is too large." }, 413);
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Request body must be valid JSON." }, 400); }
      const requestedUrl = typeof body?.url === "string" ? body.url : "";
      if (!requestedUrl) return json({ error: "Missing required string field: url." }, 400);
      try {
        return htmlFileResponse(await buildPage(requestedUrl, env));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to package webpage." }, 400);
      }
    }

    return json({ error: "Not found", expectedPaths: ["/auth", "/get-website", "/vcf-menu"] }, 404);
  }
};
