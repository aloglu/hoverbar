if (window.top === window && document.documentElement instanceof HTMLElement) {
  initHoverbar().catch((error) => {
    console.warn("Hoverbar failed to initialize", error);
  });
}

async function initHoverbar() {
  const host = document.createElement("div");
  host.id = "hoverbar-host";

  const root = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = browser.runtime.getURL("overlay.css");

  const shell = document.createElement("div");
  shell.className = "hoverbar-shell";
  shell.innerHTML = `
    <div class="hoverbar-hitbox" aria-hidden="true"></div>
    <div class="hoverbar-panel">
      <div class="hoverbar-scroll">
        <div class="hoverbar-items" role="toolbar" aria-label="Hoverbar bookmarks"></div>
      </div>
    </div>
    <div class="hoverbar-popups"></div>
  `;

  root.append(stylesheet, shell);

  const applyHost = () => {
    if (!document.documentElement.contains(host)) {
      document.documentElement.append(host);
    }
  };

  applyHost();

  if (document.readyState === "loading") {
    document.addEventListener("readystatechange", applyHost, { passive: true });
  }

  const itemsContainer = root.querySelector(".hoverbar-items");
  const scrollContainer = root.querySelector(".hoverbar-scroll");
  const popupLayer = root.querySelector(".hoverbar-popups");
  const alwaysVisible = window.location.href === "about:blank";
  let state = null;
  let openMenuPath = [];
  let anchorMap = new Map();
  let closeTimer = null;
  let hoverTimer = null;
  let hoverVisible = alwaysVisible;
  let hoverSuppressed = false;
  let chromeHoverHold = false;
  const menuScrollTops = new Map();
  const POINTER_GRACE_PX = 10;
  const TOP_REOPEN_PX = 10;

  function setThemeVars(theme) {
    setVar("--hoverbar-bg", theme.background);
    setVar("--hoverbar-fg", theme.foreground);
    setVar("--hoverbar-border", theme.border);
    setVar("--hoverbar-shadow", theme.shadow);
    host.style.setProperty("color-scheme", theme.mode || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }

  function setVar(name, value) {
    if (value) {
      host.style.setProperty(name, value);
    } else {
      host.style.removeProperty(name);
    }
  }

  function closeMenus() {
    if (alwaysVisible) {
      return;
    }

    window.clearTimeout(closeTimer);
    closeTimer = null;

    if (openMenuPath.length === 0) {
      return;
    }

    openMenuPath = [];
    render();
  }

  function toggleMenu(pathKey) {
    cancelClose();
    setOpenMenuPath(openMenuPath.includes(pathKey) ? [] : buildPathChain(pathKey));
  }

  function setMenu(pathKey) {
    cancelClose();
    setOpenMenuPath(buildPathChain(pathKey));
  }

  function scheduleClose() {
    if (alwaysVisible) {
      return;
    }

    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      const active = root.activeElement;
      if (active && host.contains(active)) {
        return;
      }

      closeMenus();
    }, 320);
  }

  function cancelClose() {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }

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

  function setHoverVisible(nextVisible) {
    if (alwaysVisible) {
      hoverVisible = true;
      shell.classList.add("grace-open");
      return;
    }

    window.clearTimeout(hoverTimer);
    hoverTimer = null;

    if (hoverSuppressed && nextVisible) {
      return;
    }

    if (hoverVisible === nextVisible) {
      return;
    }

    hoverVisible = nextVisible;
    shell.classList.toggle("grace-open", hoverVisible);
  }

  function scheduleHoverHide() {
    if (alwaysVisible) {
      return;
    }

    chromeHoverHold = false;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      hoverVisible = false;
      shell.classList.remove("grace-open");
    }, 360);
  }

  function holdHoverForBrowserChrome() {
    if (alwaysVisible) {
      return;
    }

    chromeHoverHold = true;
    cancelClose();
    window.clearTimeout(hoverTimer);
    setHoverVisible(true);
  }

  function didLeaveTowardBrowserChrome(event) {
    return !event.relatedTarget && event.clientY <= TOP_REOPEN_PX;
  }

  function render() {
    if (!state || !itemsContainer) {
      return;
    }

    anchorMap = new Map();
    shell.classList.toggle("show-names", Boolean(state.settings.showNames));
    shell.classList.toggle("show-folder-names", Boolean(state.settings.showFolderNames));
    shell.classList.toggle("menus-open", openMenuPath.length > 0);
    shell.classList.toggle("always-visible", alwaysVisible);
    shell.classList.toggle("grace-open", hoverVisible);
    shell.classList.toggle("suppress-open", hoverSuppressed);
    itemsContainer.replaceChildren(...state.items.map((item, index) => renderItem(item, `${index}`)));
    renderPopups();
  }

  function renderItem(item, pathKey) {
    const wrapper = document.createElement("div");
    wrapper.className = "hoverbar-item";

    if (item.type === "bookmark") {
      wrapper.append(createBookmark(item));
      return wrapper;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "hoverbar-button hoverbar-folder";
    button.dataset.pathKey = pathKey;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", String(openMenuPath.includes(pathKey)));
    button.title = item.title;
    button.append(buildIcon(item), buildLabel(item.title));
    anchorMap.set(pathKey, button);
    button.addEventListener("mouseenter", () => setMenu(pathKey));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu(pathKey);
    });

    wrapper.append(button);

    return wrapper;
  }

  function createMenu(children, parentPath) {
    const menu = document.createElement("div");
    menu.className = "hoverbar-menu";
    menu.setAttribute("role", "menu");
    menu.dataset.pathKey = parentPath;

    children.forEach((child, index) => {
      const pathKey = `${parentPath}.${index}`;
      const row = document.createElement("div");
      row.className = "hoverbar-menu-row";

      if (child.type === "bookmark") {
        row.append(createBookmark(child, true));
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "hoverbar-button hoverbar-folder hoverbar-menu-button";
        button.dataset.pathKey = pathKey;
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", String(openMenuPath.includes(pathKey)));
        button.title = child.title;
        button.append(buildIcon(child), buildLabel(child.title, true));
        anchorMap.set(pathKey, button);
        button.addEventListener("mouseenter", () => setMenu(pathKey));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleMenu(pathKey);
        });
        row.append(button);
      }

      menu.append(row);
    });

    return menu;
  }

  function renderPopups() {
    if (!popupLayer || !state) {
      return;
    }

    const existingMenus = new Map();
    for (const menu of popupLayer.querySelectorAll(".hoverbar-menu")) {
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
    menu.dataset.pathKey = pathKey;
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
    menu.addEventListener("scroll", () => {
      menuScrollTops.set(pathKey, menu.scrollTop);
    });
    menu.addEventListener("mouseenter", cancelClose);
    menu.addEventListener(
      "wheel",
      (event) => {
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) {
          event.preventDefault();
          return;
        }

        const sampleItem =
          menu.querySelector(".hoverbar-menu-row") ||
          menu.querySelector(".hoverbar-menu-button") ||
          menu.querySelector(".hoverbar-button");
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
  }

  function createBookmark(item, inMenu = false) {
    const anchor = document.createElement("a");
    anchor.className = "hoverbar-button hoverbar-link";
    if (inMenu) {
      anchor.classList.add("hoverbar-menu-button");
      anchor.setAttribute("role", "menuitem");
    }
    anchor.href = item.url;
    anchor.title = item.title;
    anchor.append(buildIcon(item), buildLabel(item.title, inMenu));
    const closeAfterActivation = () => {
      closeMenus();
      suppressHoverUntilTopReentry();
    };
    anchor.addEventListener("click", closeAfterActivation);
    anchor.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        closeAfterActivation();
      }
    });
    return anchor;
  }

  function buildIcon(item) {
    const iconWrap = document.createElement("span");
    iconWrap.className = "hoverbar-icon-wrap";

    if (item.type === "folder") {
      const folder = document.createElement("span");
      folder.className = "hoverbar-folder-glyph";
      folder.setAttribute("aria-hidden", "true");
      iconWrap.append(folder);
      return iconWrap;
    }

    const img = document.createElement("img");
    img.className = "hoverbar-icon";
    img.alt = "";
    const candidates = faviconCandidates(item.url);
    if (candidates.length > 0) {
      img.src = candidates[0];
      img.dataset.index = "0";
      img.dataset.candidates = JSON.stringify(candidates);
      img.addEventListener("error", rotateFaviconSource);
    }

    const fallback = document.createElement("span");
    fallback.className = "hoverbar-fallback-icon";
    fallback.setAttribute("aria-hidden", "true");
    fallback.hidden = Boolean(img.src);
    fallback.innerHTML = `
      <span class="hoverbar-fallback-ring"></span>
      <span class="hoverbar-fallback-h"></span>
      <span class="hoverbar-fallback-v"></span>
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
    label.className = inMenu ? "hoverbar-label hoverbar-label-menu" : "hoverbar-label";
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

  function syncPathToPointerTarget(target) {
    cancelClose();
    setHoverVisible(true);

    const folderButton = target.closest(".hoverbar-folder[data-path-key]");
    if (folderButton) {
      setOpenMenuPath(buildPathChain(folderButton.dataset.pathKey));
      return;
    }

    const menu = target.closest(".hoverbar-menu[data-path-key]");
    if (menu) {
      if (!openMenuPath.includes(menu.dataset.pathKey)) {
        setOpenMenuPath(buildPathChain(menu.dataset.pathKey));
      }
      return;
    }

    if (target.closest(".hoverbar-items .hoverbar-link")) {
      setOpenMenuPath([]);
    }
  }

  function isPointInsideHoverbar(clientX, clientY) {
    if (pointInRect(clientX, clientY, expandRect(shell.getBoundingClientRect(), POINTER_GRACE_PX))) {
      return true;
    }

    for (const menu of popupLayer.querySelectorAll(".hoverbar-menu")) {
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

  function suppressHoverUntilTopReentry() {
    if (alwaysVisible) {
      return;
    }

    chromeHoverHold = false;
    hoverSuppressed = true;
    setOpenMenuPath([]);
    setHoverVisible(false);
    shell.classList.add("suppress-open");
  }

  function clearHoverSuppression() {
    if (!hoverSuppressed) {
      return;
    }

    hoverSuppressed = false;
    shell.classList.remove("suppress-open");
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

  document.addEventListener("click", (event) => {
    const path = event.composedPath();
    if (!path.includes(host)) {
      closeMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
    }
  });

  shell.addEventListener("pointerleave", (event) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget && root.contains(nextTarget)) {
      return;
    }

    if (didLeaveTowardBrowserChrome(event)) {
      holdHoverForBrowserChrome();
      return;
    }

    scheduleClose();
    scheduleHoverHide();
  });

  shell.addEventListener("pointerenter", (event) => {
    if (hoverSuppressed && event.clientY > TOP_REOPEN_PX) {
      return;
    }

    clearHoverSuppression();
    chromeHoverHold = false;
    cancelClose();
    setHoverVisible(true);
  });
  shell.addEventListener("pointermove", (event) => {
    syncPathToPointerTarget(event.target);
  });
  popupLayer.addEventListener("pointerenter", () => {
    cancelClose();
    setHoverVisible(true);
  });
  popupLayer.addEventListener("pointermove", (event) => {
    syncPathToPointerTarget(event.target);
  });
  popupLayer.addEventListener("pointerleave", (event) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget && root.contains(nextTarget)) {
      return;
    }

    if (didLeaveTowardBrowserChrome(event)) {
      holdHoverForBrowserChrome();
      return;
    }

    scheduleClose();
    scheduleHoverHide();
  });

  document.addEventListener(
    "pointermove",
    (event) => {
      if (chromeHoverHold) {
        if (event.clientY <= TOP_REOPEN_PX || isPointInsideHoverbar(event.clientX, event.clientY)) {
          cancelClose();
          setHoverVisible(true);
          return;
        }

        chromeHoverHold = false;
      }

      if (hoverSuppressed) {
        if (event.clientY <= TOP_REOPEN_PX) {
          clearHoverSuppression();
          setHoverVisible(true);
        }
        return;
      }

      if (openMenuPath.length === 0) {
        return;
      }

      if (isPointInsideHoverbar(event.clientX, event.clientY)) {
        cancelClose();
        setHoverVisible(true);
        return;
      }

      scheduleClose();
      scheduleHoverHide();
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

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "hoverbar:update") {
      return;
    }

    state = message.payload;
    setThemeVars(state.theme);
    render();
  });

  state = await browser.runtime.sendMessage({ type: "hoverbar:get-state" });
  setThemeVars(state.theme);
  render();
}
