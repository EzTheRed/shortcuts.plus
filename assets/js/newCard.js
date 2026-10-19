/* Shortcuts+ Card Generator
   Configure cards in JavaScript; no visual sizing controls are required.

   Example:
   ShortcutCard.mount("#my-card", {
     index: 0,
     width: "320px",
     height: "auto",
     dataUrl: "/data/shortcuts.json",
     showCategory: true,
     showDescription: true,
     showCopyLink: true,
     showFullPage: true,
     borderRadius: "18px",
     padding: "18px"
   });

   Or auto-mount an element using data attributes:
   <div data-shortcut-index="0" data-width="320px" data-height="auto"></div>
   <script src="/assets/js/shortcut-card.js" defer></script>
*/
(function () {
  "use strict";

  var DEFAULTS = {
    dataUrl: "/data/shortcuts.json",
    index: null,
    id: null,
    width: "100%",
    height: "auto",
    padding: "18px",
    borderRadius: "18px",
    showIcon: true,
    showDescription: true,
    showCategory: true,
    showGetButton: true,
    showCopyLink: true,
    showFullPage: true,
    titleSize: "1rem",
    descriptionSize: ".9rem",
    background: "var(--card-background, #fff)",
    color: "var(--text-color, #171717)",
    borderColor: "var(--border-color, #e5e7eb)",
    accentColor: "#087ff3"
  };

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function normalizeItems(data) {
    if (Array.isArray(data)) {
      return data;
    }

    if (data && Array.isArray(data.shortcuts)) {
      return data.shortcuts;
    }

    if (data && typeof data === "object") {
      var items = [];

      Object.keys(data).forEach(function (category) {
        if (Array.isArray(data[category])) {
          data[category].forEach(function (item) {
            if (item && typeof item === "object") {
              var copy = Object.assign({}, item);

              if (copy.category == null && copy.categories == null) {
                copy.category = category;
              }

              items.push(copy);
            }
          });
        }
      });

      return items;
    }

    throw new Error("Unsupported shortcuts.json format.");
  }

  function getCategories(item) {
    var value = item.categories != null
      ? item.categories
      : item.category;

    if (value == null) {
      return [];
    }

    if (!Array.isArray(value)) {
      value = [value];
    }

    var output = [];

    value.forEach(function (entry) {
      String(entry || "").split(/[;,|]/).forEach(function (category) {
        category = category.trim();

        if (category && output.indexOf(category) === -1) {
          output.push(category);
        }
      });
    });

    return output;
  }

  function findItem(items, options) {
    var i;

    if (options.id != null) {
      for (i = 0; i < items.length; i++) {
        if (String(items[i].id) === String(options.id)) {
          return {
            item: items[i],
            index: i
          };
        }
      }

      return null;
    }

    var index = Number(options.index);

    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      return null;
    }

    return {
      item: items[index],
      index: index
    };
  }

  function render(item, index, suppliedOptions) {
    var options = Object.assign({}, DEFAULTS, suppliedOptions || {});
    var titleText = item.title || "Untitled shortcut";
    var title = escapeHTML(titleText);
    var description = escapeHTML(item.description || item.desc || "");
    var rawLink = String(item.link || item.url || "");
    var safeLink = /^https?:\/\//i.test(rawLink) ? rawLink : "#";
    var icon = item.iconUrl || item.iconURL || item.image || "";
    var categories = getCategories(item);
    var iconHTML = "";
    var categoryHTML = "";
    var descriptionHTML = "";
    var actionsHTML = "";

    if (options.showIcon) {
      iconHTML = icon
        ? '<img class="sp-card-icon" src="' + escapeHTML(icon) + '" alt="" loading="lazy">'
        : '<span class="sp-card-icon sp-card-icon-fallback" aria-hidden="true">' +
          escapeHTML(String(titleText).trim().charAt(0).toUpperCase() || "S") +
          '</span>';
    }

    if (options.showDescription && description) {
      descriptionHTML = '<p class="sp-card-description">' + description + '</p>';
    }

    if (options.showCategory && categories.length) {
      categoryHTML = '<div class="sp-card-tags">' +
        categories.map(function (category) {
          return '<span class="sp-card-tag">' + escapeHTML(category) + '</span>';
        }).join("") +
        '</div>';
    }

    if (options.showGetButton) {
      actionsHTML +=
        '<a class="sp-card-button sp-card-primary" href="' +
        escapeHTML(safeLink) +
        '" target="_blank" rel="noopener noreferrer">Get Shortcut</a>';
    }

    if (options.showCopyLink) {
      actionsHTML +=
        '<button class="sp-card-button sp-card-secondary" type="button" data-copy-link="' +
        escapeHTML(safeLink) +
        '">Copy Link</button>';
    }

    if (options.showFullPage) {
      actionsHTML +=
        '<a class="sp-card-button sp-card-secondary" href="/full?s=' +
        index +
        '">Full Page</a>';
    }

    var style = [
      "width:" + options.width,
      "height:" + options.height,
      "padding:" + options.padding,
      "border-radius:" + options.borderRadius,
      "--sp-card-bg:" + options.background,
      "--sp-card-color:" + options.color,
      "--sp-card-border:" + options.borderColor,
      "--sp-card-accent:" + options.accentColor,
      "--sp-card-title-size:" + options.titleSize,
      "--sp-card-description-size:" + options.descriptionSize
    ].join(";");

    return '<article class="sp-shortcut-card" style="' +
      escapeHTML(style) +
      '" data-shortcut-index="' +
      index +
      '">' +
      '<div class="sp-card-head">' +
      iconHTML +
      '<h2 class="sp-card-title">' + title + '</h2>' +
      '</div>' +
      descriptionHTML +
      categoryHTML +
      (actionsHTML
        ? '<div class="sp-card-actions">' + actionsHTML + '</div>'
        : "") +
      '</article>';
  }

  function ensureStyles() {
    if (document.getElementById("sp-shortcut-card-styles")) {
      return;
    }

    var style = document.createElement("style");
    style.id = "sp-shortcut-card-styles";

    style.textContent = [
      ".sp-shortcut-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;border:1px solid var(--sp-card-border);background:var(--sp-card-bg);color:var(--sp-card-color);font:inherit;overflow:auto;min-width:0}",
      ".sp-shortcut-card *{box-sizing:border-box}",
      ".sp-card-head{display:flex;align-items:center;gap:12px;min-width:0}",
      ".sp-card-icon{width:44px;height:44px;flex:0 0 44px;object-fit:cover;border-radius:12px}",
      ".sp-card-icon-fallback{display:grid;place-items:center;background:linear-gradient(135deg,#ed5cb9,#087ff3);color:#fff;font-size:21px;font-weight:700}",
      ".sp-card-title{margin:0;font-size:var(--sp-card-title-size);line-height:1.3;overflow-wrap:anywhere}",
      ".sp-card-description{margin:0;color:var(--muted-color,#666);font-size:var(--sp-card-description-size);line-height:1.45;overflow-wrap:anywhere}",
      ".sp-card-tags{display:flex;flex-wrap:wrap;gap:6px}",
      ".sp-card-tag{padding:4px 8px;border-radius:999px;background:var(--tag-background,#f1f3f5);font-size:.75rem}",
      ".sp-card-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto}",
      ".sp-card-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:8px 13px;border-radius:999px;text-decoration:none;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}",
      ".sp-card-primary{background:var(--sp-card-accent);color:#fff;border:1px solid var(--sp-card-accent)}",
      ".sp-card-secondary{border:1px solid var(--sp-card-border);color:inherit;background:transparent}",
      ".sp-card-error{padding:12px;border:1px solid #d99;border-radius:12px;color:#a22}"
    ].join("\n");

    document.head.appendChild(style);
  }

  function fallbackCopy(value, button) {
    var input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";

    document.body.appendChild(input);
    input.select();

    try {
      var ok = document.execCommand("copy");
      button.textContent = ok ? "Copied!" : "Copy failed";
    } catch (error) {
      button.textContent = "Copy failed";
    }

    input.remove();
  }

  function mount(target, suppliedOptions) {
    var container = typeof target === "string"
      ? document.querySelector(target)
      : target;

    if (!container) {
      return Promise.reject(new Error("Card container not found."));
    }

    var options = Object.assign({}, DEFAULTS, suppliedOptions || {});

    if (container.dataset.shortcutIndex != null && options.index == null) {
      options.index = container.dataset.shortcutIndex;
    }

    if (container.dataset.shortcutId != null && options.id == null) {
      options.id = container.dataset.shortcutId;
    }

    if (container.dataset.width) {
      options.width = container.dataset.width;
    }

    if (container.dataset.height) {
      options.height = container.dataset.height;
    }

    if (container.dataset.dataUrl) {
      options.dataUrl = container.dataset.dataUrl;
    }

    ensureStyles();

    return fetch(options.dataUrl, {
      cache: "no-cache"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error(
          "Could not load shortcut data (HTTP " + response.status + ")."
        );
      }

      return response.json();
    }).then(function (data) {
      var found = findItem(normalizeItems(data), options);

      if (!found) {
        throw new Error("Shortcut not found. Check the index or ID.");
      }

      container.innerHTML = render(found.item, found.index, options);

      container.onclick = function (event) {
        var button = event.target.closest("[data-copy-link]");

        if (!button || !container.contains(button)) {
          return;
        }

        var value = button.getAttribute("data-copy-link");

        if (!value || value === "#") {
          return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function () {
            button.textContent = "Copied!";
          }).catch(function () {
            fallbackCopy(value, button);
          });
        } else {
          fallbackCopy(value, button);
        }
      };

      return found.item;
    }).catch(function (error) {
      container.innerHTML =
        '<div class="sp-card-error">' +
        escapeHTML(error.message || "Unable to load shortcut.") +
        '</div>';

      throw error;
    });
  }

  function load(options) {
    options = Object.assign({}, DEFAULTS, options || {});

    return fetch(options.dataUrl, {
      cache: "no-cache"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("Could not load shortcut data.");
      }

      return response.json();
    }).then(function (data) {
      var found = findItem(normalizeItems(data), options);
      return found ? found.item : null;
    });
  }

  window.ShortcutCard = {
    mount: mount,
    render: render,
    load: load,
    defaults: Object.assign({}, DEFAULTS)
  };

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(
      "[data-shortcut-index],[data-shortcut-id]"
    ).forEach(function (container) {
      if (container.dataset.shortcutCardMounted === "true") {
        return;
      }

      container.dataset.shortcutCardMounted = "true";

      mount(container).catch(function (error) {
        if (window.console) {
          console.error(error);
        }
      });
    });
  });
})();
