const TOOLBAR_ROOT_ID = "toolbar_____";
const DEFAULT_SETTINGS = {
  showNames: false,
  showFolderNames: true
};

init().catch((error) => {
  console.error("Hoverbar new tab failed", error);
});

async function init() {
  const shell = document.querySelector(".newtab-shell");
  const scrollContainer = document.querySelector(".newtab-scroll");
  const itemsContainer = document.querySelector(".newtab-items");
  const popupLayer = document.querySelector(".newtab-popups");

  let state = null;
  let openMenuPath = [];
  let anchorMap = new Map();
  let closeTimer = null;
  const menuScrollTops = new Map();
  const POINTER_GRACE_PX = 10;

  function setOpenMenuPath(nextPath) {
    const normalized = nextPath ?? [];
    if (
      normalized.length === openMenuPath.length &&
      normalized.every((value, index) => value === openMenuPath[index])
    ) {
      return;
    }

    openMenuPath = normalized;
    render();
  }

  function closeMenus() {
    window.clearTimeout(closeTimer);
    closeTimer = null;
    setOpenMenuPath([]);
  }

  function cancelClose() {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }

  function scheduleClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeMenus();
    }, 320);
  }

  function render() {
    if (!state) {
      return;
    }

    anchorMap = new Map();
    shell.classList.toggle("show-names", Boolean(state.settings.showNames));
    shell.classList.toggle("show-folder-names", Boolean(state.settings.showFolderNames));
    itemsContainer.replaceChildren(...state.items.map((item, index) => renderItem(item, `${index}`)));
    renderPopups();
  }

  function renderItem(item, pathKey) {
    const wrapper = document.createElement("div");
    wrapper.className = "newtab-item";

    if (item.type === "bookmark") {
      wrapper.append(createBookmark(item));
      return wrapper;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "newtab-button newtab-folder";
    button.dataset.pathKey = pathKey;
    button.title = item.title;
    button.append(buildIcon(item), buildLabel(item.title));
    anchorMap.set(pathKey, button);
    button.addEventListener("mouseenter", () => setOpenMenuPath(buildPathChain(pathKey)));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setOpenMenuPath(openMenuPath.includes(pathKey) ? [] : buildPathChain(pathKey));
    });
    wrapper.append(button);
    return wrapper;
  }

  function createMenu(children, parentPath) {
    const menu = document.createElement("div");
    menu.className = "newtab-menu";
    menu.dataset.pathKey = parentPath;

    children.forEach((child, index) => {
      const pathKey = `${parentPath}.${index}`;
      const row = document.createElement("div");
      row.className = "newtab-menu-row";

      if (child.type === "bookmark") {
        row.append(createBookmark(child, true));
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "newtab-button newtab-folder newtab-menu-button";
        button.dataset.pathKey = pathKey;
        button.title = child.title;
        button.append(buildIcon(child), buildLabel(child.title, true));
        anchorMap.set(pathKey, button);
        button.addEventListener("mouseenter", () => setOpenMenuPath(buildPathChain(pathKey)));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpenMenuPath(openMenuPath.includes(pathKey) ? buildPathChain(parentPath) : buildPathChain(pathKey));
        });
        row.append(button);
      }

      menu.append(row);
    });

    bindMenuInteractions(menu);
    return menu;
  }

  function renderPopups() {
    const existingMenus = new Map();
    for (const menu of popupLayer.querySelectorAll(".newtab-menu")) {
      if (menu.dataset.pathKey) {
        menuScrollTops.set(menu.dataset.pathKey, menu.scrollTop);
        existingMenus.set(menu.dataset.pathKey, menu);
      }
    }

    popupLayer.replaceChildren();

    for (const pathKey of openMenuPath) {
      const node = findItemByPath(pathKey);
      const anchor = anchorMap.get(pathKey);
      if (!node || node.type !== "folder" || !node.children.length || !anchor) {
        continue;
      }

      const menu = existingMenus.get(pathKey) || createMenu(node.children, pathKey);
      if (existingMenus.has(pathKey)) {
        remapMenuAnchors(menu);
      }
      positionMenu(menu, anchor, pathKey);
    }
  }

  function positionMenu(menu, anchor, pathKey) {
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const viewportPadding = 8;
    const nested = pathKey.includes(".");
    const gap = nested ? 2 : 8;

    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";
    popupLayer.append(menu);

    const menuRect = menu.getBoundingClientRect();
    let left = nested ? rect.right - 1 : rect.left;
    let top = nested ? rect.top - 4 : rect.bottom + gap;
    const spaceBelow = viewportHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const maxHeight = Math.max(
      120,
      Math.min(
        viewportHeight - viewportPadding * 2,
        nested ? Math.max(spaceBelow + gap, spaceAbove + gap) : Math.max(spaceBelow, spaceAbove)
      )
    );

    if (!nested && menuRect.height > spaceBelow && spaceAbove > spaceBelow) {
      top = Math.max(viewportPadding, rect.top - gap - maxHeight);
    }

    if (nested) {
      top = Math.max(viewportPadding, Math.min(top, viewportHeight - maxHeight - viewportPadding));
    }

    if (left + menuRect.width > viewportWidth - viewportPadding) {
      left = nested ? rect.left - menuRect.width - gap : viewportWidth - menuRect.width - viewportPadding;
    }

    if (left < viewportPadding) {
      left = viewportPadding;
    }

    if (top + maxHeight > viewportHeight - viewportPadding) {
      top = Math.max(viewportPadding, viewportHeight - maxHeight - viewportPadding);
    }

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.visibility = "visible";
    menu.scrollTop = menuScrollTops.get(pathKey) || 0;
  }

  function createBookmark(item, inMenu = false) {
    const anchor = document.createElement("a");
    anchor.className = inMenu ? "newtab-button newtab-menu-button" : "newtab-button";
    anchor.href = item.url;
    anchor.title = item.title;
    anchor.append(buildIcon(item), buildLabel(item.title, inMenu));
    anchor.addEventListener("click", () => {
      setOpenMenuPath([]);
    });
    return anchor;
  }

  function buildIcon(item) {
    const iconWrap = document.createElement("span");
    iconWrap.className = "newtab-icon-wrap";

    if (item.type === "folder") {
      const folder = document.createElement("span");
      folder.className = "newtab-folder-glyph";
      iconWrap.append(folder);
      return iconWrap;
    }

    const img = document.createElement("img");
    img.className = "newtab-icon";
    img.alt = "";
    const candidates = faviconCandidates(item.url);
    if (candidates.length > 0) {
      img.src = candidates[0];
      img.dataset.index = "0";
      img.dataset.candidates = JSON.stringify(candidates);
      img.addEventListener("error", rotateFaviconSource);
    }

    const fallback = document.createElement("span");
    fallback.className = "newtab-fallback-icon";
    fallback.hidden = Boolean(img.src);
    fallback.innerHTML = `
      <span class="newtab-fallback-ring"></span>
      <span class="newtab-fallback-h"></span>
      <span class="newtab-fallback-v"></span>
    `;

    if (img.src) {
      img.addEventListener("load", () => {
        fallback.hidden = true;
      });
      img.addEventListener("error", () => {
        fallback.hidden = false;
      });
    }

    iconWrap.append(img, fallback);
    return iconWrap;
  }

  function buildLabel(title, inMenu = false) {
    const label = document.createElement("span");
    label.className = inMenu ? "newtab-label newtab-label-menu" : "newtab-label";
    label.textContent = title;
    return label;
  }

  function rotateFaviconSource(event) {
    const img = event.currentTarget;
    const candidates = JSON.parse(img.dataset.candidates || "[]");
    const currentIndex = Number(img.dataset.index || 0);
    const nextIndex = currentIndex + 1;

    if (nextIndex >= candidates.length) {
      img.remove();
      return;
    }

    img.dataset.index = String(nextIndex);
    img.src = candidates[nextIndex];
  }

  function faviconCandidates(url) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) {
        return [];
      }

      return [
        `https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`,
        `${parsed.origin}/favicon.ico`,
        `${parsed.origin}/apple-touch-icon.png`,
        `${parsed.origin}/apple-touch-icon-precomposed.png`
      ];
    } catch {
      return [];
    }
  }

  function buildPathChain(pathKey) {
    const parts = pathKey.split(".");
    return parts.map((_, index) => parts.slice(0, index + 1).join("."));
  }

  function findItemByPath(pathKey) {
    const indexes = pathKey.split(".").map((part) => Number(part));
    let list = state?.items ?? [];
    let current = null;

    for (const index of indexes) {
      current = list[index];
      if (!current) {
        return null;
      }
      list = current.children ?? [];
    }

    return current;
  }

  function remapMenuAnchors(menu) {
    for (const button of menu.querySelectorAll("[data-path-key]")) {
      anchorMap.set(button.dataset.pathKey, button);
    }
  }

  function bindMenuInteractions(menu) {
    if (menu.dataset.bound === "true") {
      return;
    }

    menu.dataset.bound = "true";
    menu.addEventListener("scroll", () => {
      if (menu.dataset.pathKey) {
        menuScrollTops.set(menu.dataset.pathKey, menu.scrollTop);
      }
    });
    menu.addEventListener(
      "wheel",
      (event) => {
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) {
          event.preventDefault();
          return;
        }

        const sampleItem =
          menu.querySelector(".newtab-menu-row") ||
          menu.querySelector(".newtab-menu-button") ||
          menu.querySelector(".newtab-button");
        const itemHeight = Math.max(34, Math.round(sampleItem?.getBoundingClientRect().height || 34));
        const normalizedDelta = normalizeWheelDelta(event, itemHeight);
        const itemsToScroll = Math.max(1, Math.min(3, Math.ceil(Math.abs(normalizedDelta) / itemHeight)));
        const limitedDelta = Math.sign(normalizedDelta) * itemHeight * itemsToScroll;
        const previousScrollTop = menu.scrollTop;
        menu.scrollTop += limitedDelta;

        if (menu.scrollTop !== previousScrollTop || menu.scrollHeight > menu.clientHeight) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      { passive: false }
    );
    menu.addEventListener("pointermove", (event) => {
      syncPathToPointerTarget(event.target);
    });
    menu.addEventListener("pointerenter", () => {
      cancelClose();
    });
  }

  function syncPathToPointerTarget(target) {
    cancelClose();

    const folderButton = target.closest(".newtab-folder[data-path-key]");
    if (folderButton) {
      setOpenMenuPath(buildPathChain(folderButton.dataset.pathKey));
      return;
    }

    const menu = target.closest(".newtab-menu[data-path-key]");
    if (menu) {
      if (!openMenuPath.includes(menu.dataset.pathKey)) {
        setOpenMenuPath(buildPathChain(menu.dataset.pathKey));
      }
      return;
    }

    if (target.closest(".newtab-items .newtab-button[href]")) {
      setOpenMenuPath([]);
    }
  }

  function isPointInsideHoverbar(clientX, clientY) {
    if (pointInRect(clientX, clientY, expandRect(shell.getBoundingClientRect(), POINTER_GRACE_PX))) {
      return true;
    }

    for (const menu of popupLayer.querySelectorAll(".newtab-menu")) {
      if (pointInRect(clientX, clientY, expandRect(menu.getBoundingClientRect(), POINTER_GRACE_PX))) {
        return true;
      }
    }

    return false;
  }

  function expandRect(rect, amount) {
    return {
      left: rect.left - amount,
      right: rect.right + amount,
      top: rect.top - amount,
      bottom: rect.bottom + amount
    };
  }

  function pointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function normalizeWheelDelta(event, itemHeight) {
    const dominantDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return dominantDelta * itemHeight;
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return dominantDelta * itemHeight * 3;
    }
    return dominantDelta;
  }

  function setThemeVars(theme) {
    setVar("--hoverbar-bg", theme.background);
    setVar("--hoverbar-fg", theme.foreground);
    setVar("--hoverbar-border", theme.border);
    setVar("--hoverbar-shadow", theme.shadow);
    document.documentElement.style.colorScheme = theme.mode || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }

  function setVar(name, value) {
    if (value) {
      document.documentElement.style.setProperty(name, value);
    } else {
      document.documentElement.style.removeProperty(name);
    }
  }

  async function loadState() {
    const [settings, subtree, theme] = await Promise.all([
      browser.storage.local.get(DEFAULT_SETTINGS),
      browser.bookmarks.getSubTree(TOOLBAR_ROOT_ID).catch(async () => {
        const tree = await browser.bookmarks.getTree();
        return [findNode(tree, TOOLBAR_ROOT_ID)];
      }),
      browser.theme.getCurrent()
    ]);

    state = {
      settings: {
        showNames: Boolean(settings.showNames),
        showFolderNames: Boolean(settings.showFolderNames)
      },
      items: sanitizeNodes(subtree?.[0]?.children ?? []),
      theme: buildTheme(theme)
    };
  }

  function sanitizeNodes(nodes) {
    return (nodes ?? [])
      .filter((node) => node && node.type !== "separator")
      .map((node) => ({
        id: node.id,
        title: node.title || friendlyTitle(node.url),
        url: node.url || null,
        type: node.url ? "bookmark" : "folder",
        children: node.url ? [] : sanitizeNodes(node.children)
      }));
  }

  function findNode(nodes, id) {
    for (const node of nodes ?? []) {
      if (node.id === id) {
        return node;
      }
      const match = findNode(node.children, id);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function friendlyTitle(url) {
    if (!url) {
      return "Untitled";
    }
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  function buildTheme(theme) {
    const colors = theme?.colors ?? {};
    const background = colors.toolbar || colors.frame || colors.popup || null;
    const foreground = colors.toolbar_text || colors.tab_text || colors.popup_text || null;
    const border = colors.toolbar_field_border || colors.popup_border || (foreground ? withAlpha(foreground, 0.18) : null);
    const shadow = background ? (isDark(background) ? "rgba(0, 0, 0, 0.45)" : "rgba(15, 23, 42, 0.18)") : null;
    const mode = theme?.properties?.color_scheme || theme?.properties?.content_color_scheme || (background ? (isDark(background) ? "dark" : "light") : null);
    return { background, foreground, border, shadow, mode };
  }

  function withAlpha(color, alpha) {
    const rgb = parseColor(color);
    if (!rgb) {
      return `rgba(31, 35, 40, ${alpha})`;
    }
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  function isDark(color) {
    const rgb = parseColor(color);
    if (!rgb) {
      return false;
    }
    const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luminance < 0.5;
  }

  function parseColor(color) {
    if (typeof color !== "string") {
      return null;
    }
    const hex = color.trim();
    if (hex.startsWith("#")) {
      const raw = hex.slice(1);
      if (raw.length === 3) {
        return {
          r: parseInt(raw[0] + raw[0], 16),
          g: parseInt(raw[1] + raw[1], 16),
          b: parseInt(raw[2] + raw[2], 16)
        };
      }
      if (raw.length >= 6) {
        return {
          r: parseInt(raw.slice(0, 2), 16),
          g: parseInt(raw.slice(2, 4), 16),
          b: parseInt(raw.slice(4, 6), 16)
        };
      }
    }
    const rgbMatch = color.match(/rgba?\(([^)]+)\)/i);
    if (!rgbMatch) {
      return null;
    }
    const parts = rgbMatch[1].split(",").map((part) => parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((part, index) => index < 3 && Number.isNaN(part))) {
      return null;
    }
    return { r: parts[0], g: parts[1], b: parts[2] };
  }

  document.addEventListener("click", (event) => {
    if (!event.composedPath().some((node) => node instanceof Element && node.closest?.(".newtab-shell"))) {
      closeMenus();
    }
  });

  shell.addEventListener("pointermove", (event) => {
    syncPathToPointerTarget(event.target);
  });
  shell.addEventListener("pointerleave", () => {
    scheduleClose();
  });
  popupLayer.addEventListener("pointerenter", () => {
    cancelClose();
  });
  popupLayer.addEventListener("pointermove", (event) => {
    syncPathToPointerTarget(event.target);
  });
  popupLayer.addEventListener("pointerleave", () => {
    scheduleClose();
  });

  document.addEventListener(
    "pointermove",
    (event) => {
      if (openMenuPath.length === 0) {
        return;
      }

      if (isPointInsideHoverbar(event.clientX, event.clientY)) {
        cancelClose();
        return;
      }

      scheduleClose();
    },
    true
  );

  scrollContainer.addEventListener(
    "wheel",
    (event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) {
        return;
      }
      const maxScroll = scrollContainer.scrollWidth - scrollContainer.clientWidth;
      if (maxScroll <= 0) {
        return;
      }
      scrollContainer.scrollLeft += delta;
      event.preventDefault();
    },
    { passive: false }
  );

  browser.bookmarks.onCreated.addListener(async () => {
    await loadState();
    render();
  });
  browser.bookmarks.onRemoved.addListener(async () => {
    await loadState();
    render();
  });
  browser.bookmarks.onChanged.addListener(async () => {
    await loadState();
    render();
  });
  browser.bookmarks.onMoved.addListener(async () => {
    await loadState();
    render();
  });
  browser.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local" || (!changes.showNames && !changes.showFolderNames)) {
      return;
    }
    await loadState();
    render();
  });
  browser.theme.onUpdated.addListener(async () => {
    await loadState();
    render();
  });

  await loadState();
  setThemeVars(state.theme);
  render();
}
