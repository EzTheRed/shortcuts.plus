const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_ASSETS = 24;
const MAX_REDIRECTS = 5;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "x-content-type-options": "nosniff"
    }
  });
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
      interaction: "Use the dynamic array to build native Shortcuts menus and prompts. Send the selected item id and any form values to POST /action.",
      actionEndpoint: "https://api.shortcuts.plus/action"
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
      "access-control-allow-headers": "Content-Type",
      "x-content-type-options": "nosniff"
    }
  });
}

function appendQuery(target, values) {
  const u = validateTarget(target);
  for (const [key, value] of Object.entries(values || {})) {
    if (Array.isArray(value)) {
      for (const v of value) u.searchParams.append(key, String(v));
    } else if (value !== undefined && value !== null && value !== "") {
      u.searchParams.set(key, String(value));
    }
  }
  return u.href;
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
        "access-control-max-age": "86400"
      }});
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Shortcuts Plus Dynamic Page API",
        status: "ok",
        endpoints: {
          initial: "/get-website?url=https%3A%2F%2Fexample.com",
          action: "POST /action with { url, actionId, values? }"
        },
        response: { file: "HTML string", dynamic: "native Shortcuts interaction definitions", metadata: "page information" }
      });
    }


    if (url.pathname === "/get-vcf") {
      if (request.method !== "POST") return json({ error: "Use POST with a JSON object mapping contact titles to subtitles." }, 405);
      try {
        const items = await request.json();
        return vcardResponse(items);
      } catch (error) {
        return json({ error: "The request body must be valid JSON." }, 400);
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

    if (url.pathname === "/action") {
      if (request.method !== "POST") return json({ error: "Use POST for actions." }, 405);
      try {
        const body = await request.json();
        if (!body || typeof body !== "object") return json({ error: "A JSON request body is required." }, 400);
        const sourceUrl = validateTarget(body.url).href;
        const actionId = String(body.actionId || "");
        if (!/^link_\d+$/.test(actionId) && !/^form_\d+$/.test(actionId)) {
          return json({ error: "Unknown or unsupported actionId." }, 400);
        }

        const currentPage = await fetchPage(validateTarget(sourceUrl));
        const dynamic = extractDynamic(currentPage.html, currentPage.finalUrl);
        const selected = dynamic.find(item => item.id === actionId);
        if (!selected) return json({ error: "That action is not available on the current page." }, 404);

        let destination;
        if (selected.type === "link") {
          destination = selected.target;
        } else if (selected.type === "form") {
          const supplied = body.values && typeof body.values === "object" ? body.values : {};
          const allowed = new Set(selected.fields.map(field => field.name));
          const values = {};
          for (const [key, value] of Object.entries(supplied)) {
            if (allowed.has(key)) values[key] = value;
          }
          destination = appendQuery(selected.target, values);
        } else {
          return json({ error: "This action type is not supported." }, 400);
        }

        return json(await buildPage(destination, executionCtx));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to process action." }, 400);
      }
    }

    return json({ error: "Not found", expectedPaths: ["/get-website", "/action"] }, 404);
  }
};
