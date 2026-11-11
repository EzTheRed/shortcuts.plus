(() => {
  "use strict";
  const A = window.ShortcutsApp;
  if (!A) return;
  const $ = A.$, esc = A.escape;

  function render(item) {
    const link = esc(item.link);
    const sourceURL = A.safeURL(item.source);
    const source = sourceURL
      ? `<a href="${esc(sourceURL)}" target="_blank" rel="noopener noreferrer">${esc(item.source)}</a>`
      : esc(item.source);
    const action = item.link && !["Planning","In Development","Testing"].includes(item.status)
      ? `<a class="button button-blue" href="${link}" target="_blank" rel="noopener noreferrer">${item.linkType === "source" ? "Open source listing" : "Get Shortcut"} ↗</a><button class="button" type="button" data-copy="${link}">Copy link</button>`
      : "";
    document.title = `${item.title} — Shortcuts+`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.content = item.desc || "View this shortcut in the Shortcuts+ library.";
    $("#app").innerHTML = `<article class="card detail-card">
      <div class="card-top"><div class="icon-bubble ${["Planning","In Development","Testing"].includes(item.status)?"dev-shortcut-icon":""}">${["Planning","In Development","Testing"].includes(item.status)?`<span class="dev-initial">${esc(item.title.trim().charAt(0).toUpperCase())}</span>`:A.iconFor(item)}</div></div>
      <p class="eyebrow">${item.category.map(esc).join(" · ")}</p>
      <h1>${esc(item.title)}</h1>
      ${item.badge ? `<p class="badge">${esc(item.badge)}</p>` : ""}
      <p>${esc(item.desc || "No description available.")}</p>
      ${item.version && !["Planning","In Development","Testing"].includes(item.status) ? `<p class="detail-version">Version ${esc(item.version)}</p>` : ""}${item.status ? `<p class="detail-version">Status: ${esc(item.status)}</p>` : ""}${!action ? `<p class="shortcut-unavailable">Preview only · Download not available</p>` : ""}
      <div class="hero-actions">${action}</div>
      ${item.source && item.source !== "UNKNOWN" ? `<p class="detail-source">Source: ${source}</p>` : ""}
      ${item.dateAdded ? `<p class="detail-date">Added ${esc(A.formatDate(item.dateAdded))}</p>` : ""}
      ${item.updated ? `<p class="detail-date">Updated ${esc(A.formatDate(item.updated))}</p>` : ""}
    </article>`;
  }

  async function start() {
    A.initTheme();
    try {
      const params = new URLSearchParams(location.search);
      const pathMatch = location.pathname.match(/^\/shortcut\/([^/]+)\/?$/);
      const id = pathMatch ? decodeURIComponent(pathMatch[1]) : params.get("shortcut");
      let item;
      if (id?.trim()) {
        item = await A.getItem(id.trim());
      } else {
        // Old index-based links resolve through the original catalog, so adding
        // or sorting registry entries cannot point them to a different shortcut.
        const raw = params.get("s");
        if (raw === null || !/^[0-9]+$/.test(raw)) throw new Error("This shortcut link is missing a valid shortcut identifier.");
        item = await A.getLegacyItem(Number(raw));
      }
      render(item);
    } catch (error) {
      console.error(error);
      $("#app").innerHTML = `<div class="empty"><strong>Could not open shortcut.</strong><span>${esc(error.message)}</span><p><a href="https://shortcuts.plus/">Browse the full library</a></p></div>`;
    }
    document.addEventListener("click", event => {
      const button = event.target.closest("[data-copy]");
      if (button) A.copy(button.dataset.copy);
    });
  }
  start();
})();
