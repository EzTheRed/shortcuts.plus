const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSETS = 24;
const MAX_REDIRECTS = 5;
const TRANSPARENT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

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


const AUTH_TOKEN_TTL_SECONDS = 10;
const AUTH_OWNER_EMAIL = "ezieriah@cutey.com";

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Utf8(value) {
  return bytesToBase64(new TextEncoder().encode(value));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function validTestCredentials(env, user, phrase) {
  if (user !== "EzTheRed" || typeof phrase !== "string" || phrase.length > 128) return false;
  let configured;
  try {
    configured = JSON.parse(env.TEST_PHRASE_HASHES || "{}");
  } catch {
    return false;
  }
  const allowedHashes = configured[user];
  if (!Array.isArray(allowedHashes)) return false;
  return allowedHashes.includes(await sha256Hex(phrase));
}

const ACCESS_ISSUER = "https://shortcutsplus.cloudflareaccess.com";
const ACCESS_AUDIENCE = "d79fd06033d8b0c4cb249326ce67429648db2aa07492ac22aca567ab0ec8932d";
let accessJwksCache = null;
let accessJwksExpiresAt = 0;

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function getAccessSigningKeys() {
  if (accessJwksCache && Date.now() < accessJwksExpiresAt) return accessJwksCache;
  const response = await fetch(ACCESS_ISSUER + "/cdn-cgi/access/certs", {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!response.ok) throw new Error("Unable to retrieve Cloudflare Access signing keys.");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("Cloudflare Access signing keys are unavailable.");
  const imported = new Map();
  for (const jwk of body.keys) {
    if (jwk?.kid && jwk.kty === "RSA" && jwk.alg === "RS256" && jwk.use === "sig") {
      imported.set(jwk.kid, await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      ));
    }
  }
  if (!imported.size) throw new Error("No usable Cloudflare Access signing keys were returned.");
  accessJwksCache = imported;
  accessJwksExpiresAt = Date.now() + 5 * 60 * 1000;
  return imported;
}

async function ownerIdentity(request) {
  const token = request.headers.get("cf-access-jwt-assertion") || "";
  if (!token || token.length > 16384) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    if (claims.iss !== ACCESS_ISSUER) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(ACCESS_AUDIENCE)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now) return null;
    if (typeof claims.iat === "number" && claims.iat > now + 60) return null;
    if (typeof claims.email !== "string" || claims.email.toLowerCase() !== AUTH_OWNER_EMAIL) return null;
    const key = (await getAccessSigningKeys()).get(header.kid);
    if (!key) return null;
    const signingInput = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const signature = decodeBase64Url(parts[2]);
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature,
      signingInput
    );
    if (!valid) return null;
    return { email: claims.email.toLowerCase(), name: claims.name || "" };
  } catch {
    return null;
  }
}

async function issueBasicToken(env, identity, name, scope, tokenType = "SHORTCUT") {
  if (!env.AUTH_DB) throw new Error("Authentication storage is not configured.");
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(tokenBytes);
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + AUTH_TOKEN_TTL_SECONDS;
  const id = crypto.randomUUID();
  await env.AUTH_DB.prepare(
    "INSERT INTO auth_tokens (id, token_hash, name, identity_email, scope, issued_at, expires_at, token_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, tokenHash, name, identity.email, scope, now, expiresAt, tokenType).run();
  const authorization = "Basic " + base64Utf8(name + ":" + token);
  return {
    name,
    scope,
    scheme: "Basic",
    authorization,
    issuedAt: now,
    expiresAt,
    validForSeconds: AUTH_TOKEN_TTL_SECONDS,
    singleUse: true
  };
}

async function consumeBasicToken(request, env, identity, scope, tokenType = "SHORTCUT") {
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
  const name = decoded.slice(0, separator);
  const token = decoded.slice(separator + 1);
  if (!/^[A-Za-z0-9._+-]{1,48}$/.test(name) || !token) return false;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  try {
    const consumed = await env.AUTH_DB.prepare(
      "UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND name = ? AND identity_email = ? AND scope = ? AND token_type = ? AND expires_at > ? AND used_at IS NULL AND revoked = 0 RETURNING id"
    ).bind(now, tokenHash, name, identity.email, scope, tokenType, now).first();
    return Boolean(consumed);
  } catch {
    return false;
  }
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
  return value.replace(new RegExp("</" + closingTag, "gi"), "<\\/" + closingTag);
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
      label: labelText(m[2], "Open link " + n),
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
  const key = new URL("https://api.shortcuts.plus/__page-cache");
  key.searchParams.set("url", validateTarget(url).href);
  return new Request(key.href, { method: "GET" });
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
    .replace(/\r\n|\r|\n/g, "\\n")
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

    const identity = await ownerIdentity(request);
    if (!identity) return json({ error: "Cloudflare Access authentication required." }, 401);

    if (url.pathname === "/auth/test") {
      if (request.method !== "POST") return json({ error: "Use POST with a JSON body containing User and Phrase." }, 405);
      const contentType = request.headers.get("content-type") || "";
      if (!/application\/json/i.test(contentType)) {
        return json({ error: "Content-Type must be application/json." }, 415);
      }
      let input;
      try {
        const body = await request.text();
        if (body.length > 2048) return json({ error: "The test authentication request body is too large." }, 413);
        input = JSON.parse(body);
      } catch {
        return json({ error: "Send valid JSON containing User and Phrase." }, 400);
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return json({ error: "The request body must be a JSON object." }, 400);
      }
      if (!await validTestCredentials(env, input.User, input.Phrase)) {
        return json({ error: "Invalid test username or phrase." }, 401);
      }
      try {
        const issued = await issueBasicToken(env, identity, input.User, "/auth/test/verify", "TEST");
        return new Response(issued.authorization, {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to issue test authentication token." }, 503);
      }
    }

    if (url.pathname === "/auth/test/verify") {
      if (request.method !== "POST") return json({ error: "Use POST with the test token in the Authorization header." }, 405);
      const valid = await consumeBasicToken(request, env, identity, "/auth/test/verify", "TEST");
      if (!valid) return json({ error: "A valid, unused, unexpired TEST token is required." }, 401);
      return json({ authenticated: true, type: "TEST", user: "EzTheRed", api: null });
    }

    if (url.pathname === "/auth") {
      if (request.method !== "POST") return json({ error: "Use POST with a JSON body containing name and api." }, 405);
      const contentType = request.headers.get("content-type") || "";
      if (!/application\/json/i.test(contentType)) {
        return json({ error: "Content-Type must be application/json." }, 415);
      }
      let input;
      try {
        const body = await request.text();
        if (body.length > 2048) return json({ error: "The authentication request body is too large." }, 413);
        input = JSON.parse(body);
      } catch {
        return json({ error: "Send valid JSON containing name and api." }, 400);
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return json({ error: "The request body must be a JSON object." }, 400);
      }
      const name = typeof input.name === "string" ? input.name : "";
      const api = typeof input.api === "string" ? input.api : "";
      const scope = api === "get-website" ? "/get-website" : api === "vcf-menu" ? "/vcf-menu" : "";
      if (!/^[A-Za-z0-9._+-]{1,48}$/.test(name)) {
        return json({ error: "A name is required. Use 1-48 letters, numbers, dots, underscores, plus signs, or hyphens." }, 400);
      }
      if (!scope) return json({ error: "api must be get-website or vcf-menu." }, 400);
      if (!env.AUTH_DB) return json({ error: "Authentication storage is not configured." }, 503);
      let allowedShortcut;
      try {
        allowedShortcut = await env.AUTH_DB.prepare(
          "SELECT name FROM allowed_shortcuts WHERE name = ? AND enabled = 1"
        ).bind(name).first();
      } catch {
        return json({ error: "Shortcut allowlist storage is unavailable." }, 503);
      }
      if (!allowedShortcut) {
        return json({ error: "This shortcut name is not registered for production API access." }, 403);
      }
      try {
        const issued = await issueBasicToken(env, identity, name, scope);
        return new Response(issued.authorization, {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to issue authentication token." }, 503);
      }
    }

    if (url.pathname === "/auth/logs") {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      if (!env.AUTH_DB) return json({ error: "Authentication storage is not configured." }, 503);
      const requestedLimit = Number(url.searchParams.get("limit") || 30);
      const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 30;
      const result = await env.AUTH_DB.prepare(
        "SELECT id, name, identity_email, scope, token_type, issued_at, expires_at, used_at, substr(token_hash, 1, 16) AS fingerprint FROM auth_tokens WHERE identity_email = ? ORDER BY issued_at DESC LIMIT ?"
      ).bind(identity.email, limit).all();
      return json({
        count: result.results.length,
        logs: result.results.map(row => ({
          id: row.id,
          name: row.name,
          identity: row.identity_email,
          api: row.scope === "/auth/test/verify" ? null : row.scope,
          type: row.token_type || "SHORTCUT",
          tokenFingerprint: row.fingerprint,
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
          usedAt: row.used_at
        }))
      });
    }

    if (url.pathname === "/get-website" || url.pathname === "/vcf-menu") {
      if (request.method !== "GET") return json({ error: "Only GET requests are supported for this endpoint." }, 405);
      const valid = await consumeBasicToken(request, env, identity, url.pathname);
      if (!valid) return json({ error: "A valid, unused, unexpired Basic authentication token for this API is required." }, 401);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Shortcuts Plus Website API",
        status: "ok",
        endpoints: {
          auth: "POST /auth with JSON {name, api} (Cloudflare Access required)",
          testAuth: "POST /auth/test with JSON {User, Phrase}; verify at POST /auth/test/verify (TEST-only)",
          authLogs: "GET /auth/logs?limit=30 (owner-only audit log)",
          website: "GET /get-website?url=<URL-encoded-public-website> (Basic token required)",
          vcfMenu: "GET /vcf-menu?data=<URL-encoded-JSON-object> (Basic token required)"
        },
        response: { file: "packaged HTML string", dynamic: "preloaded link and GET-form definitions", metadata: "page information" }
      });
    }


    if (url.pathname === "/vcf-menu") {
      if (request.method !== "GET") return json({ error: "Use GET with a URL-encoded JSON object in the data query parameter." }, 405);
      const data = url.searchParams.get("data");
      if (!data) return json({ error: "Missing required data query parameter. URL-encode a JSON object mapping contact titles to subtitles." }, 400);
      if (data.length > 8000) return json({ error: "The encoded data parameter is too long. Keep the JSON small enough to fit in a URL." }, 414);
      try {
        return vcardResponse(JSON.parse(data));
      } catch (error) {
        return json({ error: "The data query parameter must contain valid URL-encoded JSON." }, 400);
      }
    }

    if (url.pathname === "/get-website") {
      if (request.method !== "GET") return json({ error: "Only GET requests are supported for this endpoint." }, 405);
      const requestedUrl = url.searchParams.get("url");
      if (!requestedUrl) return json({ error: "Missing required url parameter." }, 400);
      try {
        return json(await buildPage(requestedUrl, executionCtx));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to package webpage." }, 400);
      }
    }

    return json({ error: "Not found", expectedPaths: ["/auth", "/auth/test", "/auth/test/verify", "/auth/logs", "/get-website", "/vcf-menu"] }, 404);
  }
};
