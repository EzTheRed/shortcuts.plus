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


function attr(attrs, name) {
  const re = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function labelText(value, fallback) {
  const text = value.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 120);
}

function safeActionUrl(raw, base) {
  try {
    const u = validateTarget(new URL(raw, base).href);
    return u.href;
  } catch {
    return null;
  }
}

function extractDynamic(html, pageUrl) {
  const dynamic = [];
  const seen = new Set();
  const add = item => {
    if (dynamic.length < 60 && !seen.has(item.id)) {
      seen.add(item.id);
      dynamic.push(item);
    }
  };

  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let n = 0;
  for (const m of html.matchAll(anchorRe)) {
    const rawHref = attr(m[1], "href");
    if (!rawHref || /^(javascript:|mailto:|tel:|#)/i.test(rawHref)) continue;
    const href = safeActionUrl(rawHref, pageUrl);
    if (!href) continue;
    n++;
    add({
      id: "link_" + n,
      label: attr(m[1], "aria-label") || labelText(m[2], "Open link " + n),
      type: "link",
      method: "GET",
      target: href
    });
  }

  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let formIndex = 0;
  for (const form of html.matchAll(formRe)) {
    const attrs = form[1];
    const method = (attr(attrs, "method") || "GET").toUpperCase();
    if (method !== "GET") continue;
    const rawAction = attr(attrs, "action") || pageUrl;
    const target = safeActionUrl(rawAction, pageUrl);
    if (!target) continue;
    formIndex++;
    const fields = [];
    const controlRe = /<(input|textarea|select)\b([^>]*?)(?:>([\s\S]*?)<\/\1\s*>|\/?>)/gi;
    let fieldIndex = 0;
    for (const control of form[2].matchAll(controlRe)) {
      const tag = control[1].toLowerCase();
      const a = control[2];
      const type = (attr(a, "type") || (tag === "select" ? "select" : tag)).toLowerCase();
      const name = attr(a, "name");
      if (!name || ["submit", "button", "reset", "image", "file"].includes(type) || attr(a, "disabled") !== "") continue;
      fieldIndex++;
      const options = [];
      if (tag === "select") {
        const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
        for (const opt of (control[3] || "").matchAll(optionRe)) {
          const value = attr(opt[1], "value") || labelText(opt[2], "");
          if (value) options.push({ label: labelText(opt[2], value), value });
        }
      }
      fields.push({
        id: "field_" + fieldIndex,
        name,
        label: attr(a, "aria-label") || attr(a, "placeholder") || attr(a, "title") || name,
        type: tag === "select" ? "select" : (type === "checkbox" || type === "radio" ? type : "text"),
        required: /(?:^|\s)required(?:\s|$)/i.test(a),
        ...(options.length ? { options } : {}),
        ...(type === "checkbox" ? { value: attr(a, "value") || "on" } : {})
      });
    }
    if (fields.length) {
      add({
        id: "form_" + formIndex,
        label: attr(attrs, "aria-label") || attr(attrs, "name") || "Submit form " + formIndex,
        type: "form",
        method: "GET",
        target,
        fields
      });
    }
  }

  return dynamic;
}

function responseDictionary(file, dynamic, metadata = {}) {
  return {
    file,
    dynamic,
    metadata: {
      title: metadata.title || "Webpage",
      source: metadata.source || "",
      version: 1,
      generatedAt: new Date().toISOString(),
      ...metadata
    },
    instructions: {
      interaction: "Use the dynamic array to build native Shortcuts menus and prompts. For a selected link, request /get-website again using its target URL. For a GET form, collect the listed field values, add them to the target URL as query parameters, then request /get-website with that URL.",
      endpoint: "https://api.shortcuts.plus/get-website"
    }
  };
}

function pageTitle(html) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return m ? labelText(m[1], "Webpage") : "Webpage";
}

function pageCacheKey(url) {
  const key = new URL("https://api.shortcuts.plus/__page-cache-v7");
  key.searchParams.set("url", validateTarget(url).href);
  return new Request(key.href, { method: "GET" });
}



function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function renderShortcutsPlusMenu() {
  const dataUrl = "https://shortcuts.plus/data/shortcuts.json";
  const context = makeContext();
  const fetched = await fetchResource(dataUrl, context, "js");
  if (!/json/i.test(fetched.contentType)) throw new Error("The shortcuts data endpoint did not return JSON.");

  let records;
  try { records = JSON.parse(fetched.text); }
  catch { throw new Error("The shortcuts data file contains invalid JSON."); }
  if (!Array.isArray(records)) throw new Error("The shortcuts data file must contain an array.");

  const entries = records.slice(0, 60).filter(item =>
    item && typeof item.title === "string" && typeof item.link === "string"
  ).map(item => {
    let safeLink = "";
    try {
      const parsed = new URL(item.link);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) safeLink = parsed.href;
    } catch {}
    return { ...item, safeLink };
  }).filter(item => item.safeLink);

  const cards = entries.map(item => {
    const description = typeof item.desc === "string" ? item.desc : "A shortcut made for the Shortcuts app.";
    const badge = "FEATURED";
    const categories = Array.isArray(item.category)
      ? item.category.filter(x => typeof x === "string").slice(0, 3)
      : [];
    const chips = categories.map(value => '<span class="chip">' + escapeHtml(value) + '</span>').join("");
    return '<article class="project-card"><div class="card-top"><span class="app-icon" aria-hidden="true">↗</span><span class="badge">' +
      escapeHtml(badge) + '</span><span class="card-index">01 / ' + String(entries.length).padStart(2, "0") +
      '</span></div><h2>' + escapeHtml(item.title) + '</h2><p class="card-description">' +
      escapeHtml(description) + '</p><div class="chips">' + chips +
      '</div><div class="card-bottom"><span class="card-note">BUILT FOR APPLE SHORTCUTS</span><a class="project-link" href="' +
      escapeHtml(item.safeLink) + '">View shortcut <span aria-hidden="true">↗</span></a></div></article>';
  }).join("");

  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#111318">',
    '<title>Shortcuts+ — Quick Look Showcase</title>',
    '<style>',
    ':root{color-scheme:light;--bg:#f4f6f9;--panel:#fff;--panel2:#eef2f7;--ink:#172437;--muted:#617086;--line:#dce3ec;--accent:#245b9e;--accent2:#6d89ad}',
    '*{box-sizing:border-box}html{min-height:100%;background:var(--bg)}body{margin:0;background:linear-gradient(180deg,#fff 0,#f4f6f9 440px);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}',
    '.page{width:min(100% - 40px,760px);margin:0 auto;padding:28px 0 44px}.nav{display:flex;justify-content:space-between;align-items:center;padding:2px 0 22px;border-bottom:1px solid var(--line)}',
    '.brand{font-size:19px;font-weight:750;letter-spacing:-.045em;color:var(--ink);text-decoration:none}.brand span{color:var(--accent)}.nav-pill{font-size:9px;letter-spacing:.12em;font-weight:750;color:#385b83;border:1px solid #d5dfeb;border-radius:4px;padding:6px 9px;background:#f7f9fc}',
    '.hero{padding:46px 0 28px}.eyebrow{display:flex;align-items:center;gap:9px;color:#526a87;font-size:10px;font-weight:750;letter-spacing:.15em;text-transform:uppercase}.eyebrow:before{content:"";width:18px;height:2px;background:var(--accent)}',
    'h1{font-size:clamp(39px,8vw,62px);line-height:1.02;letter-spacing:-.065em;margin:14px 0 15px;font-weight:780;color:#172437}h1 em{font-style:normal;color:var(--accent)}.intro{max-width:570px;color:#596a80;font-size:15px;line-height:1.75;margin:0}',
    '.preview{margin:8px 0 30px;padding:15px;border:1px solid #dce3ec;border-radius:12px;background:#fff;box-shadow:0 8px 24px #24364b0b}',
    '.preview-bar{display:flex;align-items:center;gap:6px;padding:2px 3px 12px;border-bottom:1px solid #e8edf3}.dot{width:7px;height:7px;border-radius:50%;background:#aab7c7}.preview-label{margin-left:7px;color:#6d7d91;font-size:9px;letter-spacing:.1em;font-weight:750}',
    '.preview-content{padding:22px 8px 13px}.preview-kicker{font-size:9px;letter-spacing:.15em;color:#567397;font-weight:750}.preview-title{font-size:25px;line-height:1.15;letter-spacing:-.045em;color:#1b2b40;font-weight:750;margin:9px 0 7px}.preview-copy{font-size:12px;color:#65758a;max-width:420px;margin:0;line-height:1.7}.preview-lines{display:flex;gap:7px;margin-top:17px}.preview-lines span{height:5px;border-radius:4px;background:#e7ecf2;display:block}.preview-lines span:first-child{width:34%}.preview-lines span:nth-child(2){width:19%;background:#9bb4d2}.preview-lines span:nth-child(3){width:12%}',
    '.section-head{display:flex;justify-content:space-between;align-items:center;margin:0 0 12px}.section-label{font-size:10px;letter-spacing:.15em;font-weight:750;color:#526781}.count{font-size:10px;color:#78879a}',
    '.project-card{border:1px solid #dce3ec;border-radius:12px;padding:21px;background:#fff;box-shadow:0 5px 18px #24364b08}.card-top{display:flex;align-items:center;gap:9px}.app-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:#eaf0f7;color:#285b91;font-size:19px;font-weight:750}.badge{font-size:9px;letter-spacing:.1em;font-weight:750;color:#365d86;background:#f1f5fa;border:1px solid #dce5ef;border-radius:4px;padding:5px 8px}.card-index{margin-left:auto;color:#8794a5;font-size:10px;font-variant-numeric:tabular-nums}',
    '.project-card h2{font-size:26px;letter-spacing:-.05em;color:#1b2b40;margin:17px 0 5px}.card-description{font-size:13px;color:#637389;line-height:1.7;margin:0;max-width:540px}.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:15px}.chip{font-size:10px;color:#526781;padding:5px 9px;border-radius:5px;background:#f6f8fb;border:1px solid #e2e8f0}',
    '.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #e8edf3;margin-top:19px;padding-top:15px}.card-note{font-size:8px;letter-spacing:.12em;color:#8794a5;font-weight:750}.project-link{color:#245b9e;text-decoration:none;font-size:12px;font-weight:750}.project-link span{padding-left:4px}',
    '.quicklook{margin-top:24px;padding:18px 19px;border:1px solid #dce3ec;border-radius:10px;background:#eef2f7}.quicklook h3{font-size:14px;color:#1d3048;margin:0 0 6px;letter-spacing:-.02em}.quicklook p{font-size:12px;line-height:1.75;color:#5e6f84;margin:0}.quicklook strong{color:#263e5b}',
    'footer{display:flex;justify-content:space-between;gap:12px;margin-top:26px;padding-top:16px;border-top:1px solid var(--line);color:#7b899a;font-size:9px;letter-spacing:.04em}.footer-mark{font-weight:800;letter-spacing:.02em;color:#536780}',
    '@media(min-width:560px){.page{padding-top:36px}.hero{padding-top:54px}.preview{padding:18px}.preview-content{padding:26px 12px 16px}.project-card{padding:25px}}',

    '</style></head><body><main class="page">',
    '<nav class="nav"><a class="brand" href="https://shortcuts.plus/">Shortcuts<span>+</span></a><span class="nav-pill">SHORTCUTS SHOWCASE</span></nav>',
    '<header class="hero"><div class="eyebrow">Apple Shortcuts Showcase</div><h1>A clearer view of<br><em>Shortcuts.</em></h1>',
    '<p class="intro">A curated presentation of utility-focused shortcuts for Apple devices, with concise project information and direct access to each shortcut.</p></header>',
    '<section class="preview" aria-label="Quick Look preview"><div class="preview-bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="preview-label">SHORTCUTS+ / QUICK LOOK</span></div>',
    '<div class="preview-content"><div class="preview-kicker">PLATFORM OVERVIEW</div><div class="preview-title">Shortcuts, presented<br>with clarity.</div><p class="preview-copy">A streamlined project index with clear descriptions, categories, and direct shortcut links.</p><div class="preview-lines"><span></span><span></span><span></span></div></div></section>',
    '<section aria-label="Featured shortcuts"><div class="section-head"><h2 class="section-label">FEATURED SHORTCUTS</h2><span class="count">' + entries.length + ' ITEM' + (entries.length === 1 ? '' : 'S') + '</span></div>',
    '<div class="projects">' + cards + '</div></section>',
    '<aside class="quicklook"><h3>Quick Look compatibility</h3><p>The showcase uses a <strong>self-contained static layout</strong>. Its structure and styling are included in the page, minimizing dependencies on external scripts and design assets when displayed in Quick Look.</p></aside>',
    '<footer><span>APPLE SHORTCUTS · PROJECT DIRECTORY</span><span class="footer-mark">SHORTCUTS+</span></footer>',
    '</main></body></html>'
  ].join("\n");

  return { html, count: entries.length, dataUrl };
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

async function buildPage(url, executionCtx = null, shouldPreload = true) {
  const target = validateTarget(url).href;
  const cache = caches.default;
  const key = pageCacheKey(target);
  const cached = await cache.match(key);
  if (cached) {
    const data = await cached.json();
    data.metadata.cacheHit = true;
    return data;
  }

  const fetched = await fetchPage(validateTarget(target));
  const final = new URL(fetched.finalUrl);
  const isShortcutsPlusHome =
    (final.hostname.toLowerCase() === "shortcuts.plus" || final.hostname.toLowerCase() === "www.shortcuts.plus") &&
    final.pathname === "/" && !final.search;

  if (isShortcutsPlusHome) {
    const menu = await renderShortcutsPlusMenu();
    const dynamic = extractDynamic(menu.html, fetched.finalUrl);
    const result = responseDictionary(menu.html, dynamic, {
      title: "Shortcuts Plus — All Shortcuts",
      source: fetched.finalUrl,
      finalUrl: fetched.finalUrl,
      renderer: "shortcuts-plus-menu",
      shortcutCount: menu.count,
      dataSource: menu.dataUrl,
      inlinedAssets: 0,
      skippedAssets: [],
      cacheHit: false,
      preloaded: []
    });
    await cache.put(key, new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=180" }
    }));
    return result;
  }

  const youtubeHost = /(^|\.)youtube\.com$/i.test(final.hostname);
  if (youtubeHost) {
    const videos = extractYouTubeVideos(fetched.html, fetched.finalUrl);
    if (videos.length) {
      const rendered = renderYouTubeFeed(videos, fetched.finalUrl);
      const dynamic = extractDynamic(rendered, fetched.finalUrl);
      const result = responseDictionary(rendered, dynamic, {
        title: "YouTube — Static Feed",
        source: fetched.finalUrl,
        finalUrl: fetched.finalUrl,
        renderer: "youtube-static-feed",
        videoCount: videos.length,
        inlinedAssets: 0,
        skippedAssets: [],
        cacheHit: false,
        preloaded: []
      });
      await cache.put(key, new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=180" }
      }));
      return result;
    }
  }

  const packaged = await packageHtml(fetched.html, fetched.finalUrl);
  const dynamic = extractDynamic(fetched.html, fetched.finalUrl);
  const preloadCandidates = [];
  if (shouldPreload) {
    const origin = new URL(fetched.finalUrl).origin;
    for (const item of dynamic) {
      if (item.type !== "link") continue;
      try {
        const candidate = validateTarget(item.target);
        if (candidate.origin !== origin || candidate.href === fetched.finalUrl) continue;
        if (preloadCandidates.some(x => x.target === candidate.href)) continue;
        preloadCandidates.push({ id: item.id, label: item.label, target: candidate.href });
        if (preloadCandidates.length >= 4) break;
      } catch {}
    }
  }

  const result = responseDictionary(packaged.html, dynamic, {
    title: pageTitle(fetched.html),
    source: fetched.finalUrl,
    finalUrl: fetched.finalUrl,
    inlinedAssets: packaged.context.assets,
    skippedAssets: packaged.context.skipped,
    cacheHit: false,
    preloaded: preloadCandidates.map(({ id, label }) => ({ id, label }))
  });

  await cache.put(key, new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=180"
    }
  }));

  if (executionCtx && typeof executionCtx.waitUntil === "function" && preloadCandidates.length) {
    executionCtx.waitUntil(Promise.allSettled(
      preloadCandidates.map(item => buildPage(item.target, null, false))
    ));
  }
  return result;
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
  async fetch(request, env, executionCtx) {
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
        response: { file: "packaged HTML string", dynamic: "preloaded link and GET-form definitions", metadata: "page information" }
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
        return json(await buildPage(requestedUrl, executionCtx));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to package webpage." }, 400);
      }
    }

    return json({ error: "Not found", expectedPaths: ["/auth", "/get-website", "/vcf-menu"] }, 404);
  }
};
