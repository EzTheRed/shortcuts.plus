const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "x-content-type-options": "nosniff"
    }
  });
}

function isPrivateOrLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example")
  ) return true;

  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/i.test(host) ||
      host.startsWith("::ffff:")
    );
  }

  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  return false;
}

function validateTarget(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error("Provide a webpage URL no longer than 2048 characters.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The supplied URL is not valid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS webpage URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing usernames or passwords are not allowed.");
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error("Local, private, and reserved network addresses are not allowed.");
  }

  url.hash = "";
  return url;
}

async function fetchPublicPage(initialUrl) {
  let target = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    target = validateTarget(target.href);
    const response = await fetch(target.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        "accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": "ShortcutsPlus-PageFetcher/1.0"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The remote site returned a redirect without a destination.");
      if (redirects === MAX_REDIRECTS) throw new Error("The remote site redirected too many times.");
      target = new URL(location, target);
      continue;
    }

    if (!response.ok) throw new Error(`The remote website returned HTTP ${response.status}.`);

    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error("The URL did not return an HTML webpage.");
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error("The webpage is larger than the 2 MB response limit.");

    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
      throw new Error("The webpage is larger than the 2 MB response limit.");
    }

    return { html, finalUrl: target.href };
  }

  throw new Error("Unable to retrieve the webpage.");
}

function addBaseUrl(html, baseUrl) {
  const safeBase = baseUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const baseTag = `<base href="${safeBase}">`;
  const withoutBase = html.replace(/<base\b[^>]*>/i, "");
  if (/<head\b[^>]*>/i.test(withoutBase)) {
    return withoutBase.replace(/<head\b[^>]*>/i, (head) => `${head}\n${baseTag}`);
  }
  return `${baseTag}\n${withoutBase}`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "Content-Type",
          "access-control-max-age": "86400"
        }
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Shortcuts Plus Page Fetcher",
        status: "ok",
        endpoint: "/get-website?url=https%3A%2F%2Fexample.com"
      });
    }

    if (url.pathname !== "/get-website") {
      return json({ error: "Not found", expectedPath: "/get-website" }, 404);
    }

    if (request.method !== "GET") return json({ error: "Only GET requests are supported." }, 405);

    const requestedUrl = url.searchParams.get("url");
    if (!requestedUrl) {
      return json({
        error: "Missing required url parameter.",
        example: "https://api.shortcuts.plus/get-website?url=https%3A%2F%2Fexample.com"
      }, 400);
    }

    try {
      const target = validateTarget(requestedUrl);
      const result = await fetchPublicPage(target);
      const html = addBaseUrl(result.html, result.finalUrl);

      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "x-shortcuts-original-url": result.finalUrl
        }
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unable to fetch webpage." }, 400);
    }
  }
};
