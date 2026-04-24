const HOVERBAR_PAGE_TYPES = new Set(["text/html", "application/xhtml+xml"]);

if (
  window.top === window &&
  document.documentElement instanceof HTMLElement &&
  HOVERBAR_PAGE_TYPES.has(document.contentType)
) {
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
    <div class="hoverbar-context-menu" hidden></div>
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
  const contextMenu = root.querySelector(".hoverbar-context-menu");
  const alwaysVisible = window.location.href === "about:blank";
  let state = null;
  let openMenuPath = [];
  let anchorMap = new Map();
  let itemMap = new Map();
  let closeTimer = null;
  let hoverTimer = null;
  let hoverVisible = alwaysVisible;
  let hoverSuppressed = false;
  let chromeHoverHold = false;
  let draggedItem = null;
  let dragOpenTimer = null;
  let dragOpenTargetId = null;
  let layoutScale = 1;
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

  function setSettingsVars(settings) {
    setShellVar("--hoverbar-folder-color", settings.folderColor);
  }

  function setZoomVars(zoom) {
    const normalizedZoom = typeof zoom === "number" && zoom > 0 ? zoom : 1;
    layoutScale = 1 / normalizedZoom;
    shell.style.setProperty("--hoverbar-zoom-scale", String(layoutScale));
  }

  function setVar(name, value) {
    if (value) {
      host.style.setProperty(name, value);
    } else {
      host.style.removeProperty(name);
    }
  }

  function setShellVar(name, value) {
    if (value) {
      shell.style.setProperty(name, value);
    } else {
      shell.style.removeProperty(name);
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
    syncOpenMenuState();
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
    if (alwaysVisible || draggedItem) {
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
    syncOpenMenuState();
  }

  function setOpenMenuPathForDrag(nextPath) {
    const normalized = nextPath ?? [];
    if (
      normalized.length === openMenuPath.length &&
      normalized.every((value, index) => value === openMenuPath[index])
    ) {
      return;
    }

    openMenuPath = normalized;
    syncOpenMenuState();
  }

  function syncOpenMenuState() {
    shell.classList.toggle("menus-open", openMenuPath.length > 0);
    for (const button of root.querySelectorAll("[data-path-key]")) {
      button.setAttribute("aria-expanded", String(openMenuPath.includes(button.dataset.pathKey)));
    }
    renderPopups();
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
    if (alwaysVisible || draggedItem) {
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
    itemMap = buildItemMap(state.items);
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
    setItemDataset(button, item);
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
    bindItemInteractions(button, item);

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
        setItemDataset(button, child);
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
        bindItemInteractions(button, child);
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

    for (const menu of popupLayer.querySelectorAll(".hoverbar-menu")) {
      if (menu.dataset.pathKey) {
        menuScrollTops.set(menu.dataset.pathKey, menu.scrollTop);
      }
    }

    popupLayer.replaceChildren();

    for (const pathKey of openMenuPath) {
      const node = findItemByPath(pathKey);
      const anchor = anchorMap.get(pathKey);

      if (!node || node.type !== "folder" || !node.children.length || !anchor) {
        continue;
      }

      const menu = createMenu(node.children, pathKey);
      positionMenu(menu, anchor, pathKey);
      bindMenuInteractions(menu);
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

    menu.style.left = `${left / layoutScale}px`;
    menu.style.top = `${top / layoutScale}px`;
    menu.style.maxHeight = `${maxHeight / layoutScale}px`;
    menu.style.visibility = "visible";
    menu.scrollTop = menuScrollTops.get(pathKey) || 0;
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
    setItemDataset(anchor, item);
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
    bindItemInteractions(anchor, item);
    return anchor;
  }

  function setItemDataset(element, item) {
    element.dataset.bookmarkId = item.id;
    element.dataset.bookmarkType = item.type;
    if (item.parentId) {
      element.dataset.parentId = item.parentId;
    }
    if (Number.isInteger(item.index)) {
      element.dataset.index = String(item.index);
    }
    if (item.url) {
      element.dataset.url = item.url;
    }
  }

  function bindItemInteractions(element, item) {
    element.draggable = true;
    element.addEventListener("dragstart", (event) => {
      hideContextMenu();
      draggedItem = item;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-hoverbar-bookmark-id", item.id);
      event.dataTransfer.setData("text/plain", item.url || item.title);
      element.classList.add("is-dragging");
    });
    element.addEventListener("dragend", () => {
      draggedItem = null;
      cancelDragOpen();
      clearDropTargets();
      element.classList.remove("is-dragging");
    });
    element.addEventListener("dragover", (event) => {
      if (!canDropOn(item)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      markDropTarget(element, getDropOperation(item, event));
      scheduleDragOpen(item);
    });
    element.addEventListener("dragenter", (event) => {
      if (!canDropOn(item)) {
        return;
      }

      event.preventDefault();
      scheduleDragOpen(item);
    });
    element.addEventListener("dragleave", () => {
      element.classList.remove("drop-before", "drop-after", "drop-inside");
    });
    element.addEventListener("drop", (event) => {
      if (!canDropOn(item)) {
        return;
      }

      event.preventDefault();
      hideContextMenu();
      cancelDragOpen();
      moveDraggedItem(item, getDropOperation(item, event)).catch((error) => {
        console.warn("Hoverbar bookmark move failed", error);
      });
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(item, event.clientX, event.clientY);
    });
  }

  function scheduleDragOpen(item) {
    if (item.type !== "folder") {
      cancelDragOpen();
      return;
    }

    if (dragOpenTargetId === item.id && dragOpenTimer) {
      return;
    }

    window.clearTimeout(dragOpenTimer);
    dragOpenTargetId = item.id;
    dragOpenTimer = window.setTimeout(() => {
      if (dragOpenTargetId !== item.id) {
        return;
      }

      const pathKey = findPathById(item.id);
      if (pathKey) {
        setOpenMenuPathForDrag(buildPathChain(pathKey));
      }
      dragOpenTimer = null;
    }, 220);
  }

  function cancelDragOpen(item = null) {
    if (item && dragOpenTargetId !== item.id) {
      return;
    }

    window.clearTimeout(dragOpenTimer);
    dragOpenTimer = null;
    dragOpenTargetId = null;
  }

  function syncDragOpenToPoint(clientX, clientY) {
    if (!draggedItem) {
      return;
    }

    const folderButton = folderButtonFromPoint(clientX, clientY);
    if (!folderButton) {
      cancelDragOpen();
      return;
    }

    const folder = itemMap.get(folderButton.dataset.bookmarkId);
    if (canDropOn(folder)) {
      scheduleDragOpen(folder);
    }
  }

  function folderButtonFromPoint(clientX, clientY) {
    for (const button of root.querySelectorAll(".hoverbar-folder[data-path-key]")) {
      if (button.dataset.bookmarkId === draggedItem?.id) {
        continue;
      }

      if (pointInRect(clientX, clientY, expandRect(button.getBoundingClientRect(), 4))) {
        return button;
      }
    }

    return null;
  }

  function buildItemMap(items, map = new Map()) {
    for (const item of items ?? []) {
      map.set(item.id, item);
      buildItemMap(item.children, map);
    }
    return map;
  }

  function findPathById(id, items = state?.items ?? [], prefix = "") {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const pathKey = prefix ? `${prefix}.${index}` : `${index}`;
      if (item.id === id) {
        return pathKey;
      }
      const childPath = findPathById(id, item.children ?? [], pathKey);
      if (childPath) {
        return childPath;
      }
    }
    return null;
  }

  function canDropOn(target) {
    if (!draggedItem || !target || draggedItem.id === target.id) {
      return false;
    }

    if (draggedItem.type === "folder" && isDescendant(target, draggedItem.id)) {
      return false;
    }

    return true;
  }

  function isDescendant(item, ancestorId) {
    let current = item;
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = itemMap.get(current.parentId);
    }
    return false;
  }

  function getDropOperation(target, event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const horizontal = !event.currentTarget.closest(".hoverbar-menu");
    const coordinate = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const size = horizontal ? rect.width : rect.height;
    const beforeEdge = size * 0.28;
    const afterEdge = size * 0.72;

    if (coordinate < beforeEdge) {
      return "before";
    }

    if (coordinate > afterEdge) {
      return "after";
    }

    return target.type === "folder" ? "inside" : "after";
  }

  function markDropTarget(element, operation) {
    clearDropTargets();
    element.classList.add(`drop-${operation}`);
  }

  function clearDropTargets() {
    for (const element of root.querySelectorAll(".drop-before, .drop-after, .drop-inside")) {
      element.classList.remove("drop-before", "drop-after", "drop-inside");
    }
  }

  async function moveDraggedItem(target, operation) {
    if (!canDropOn(target)) {
      return;
    }

    clearDropTargets();

    if (operation === "inside" && target.type === "folder") {
      await browser.runtime.sendMessage({
        type: "hoverbar:move-bookmark",
        payload: {
          id: draggedItem.id,
          parentId: target.id
        }
      });
      return;
    }

    if (!target.parentId || !Number.isInteger(target.index)) {
      return;
    }

    await browser.runtime.sendMessage({
      type: "hoverbar:move-bookmark",
      payload: {
        id: draggedItem.id,
        parentId: target.parentId,
        index: destinationIndex(target, operation)
      }
    });
  }

  function destinationIndex(target, operation) {
    let index = target.index + (operation === "after" ? 1 : 0);
    if (draggedItem.parentId === target.parentId && Number.isInteger(draggedItem.index) && draggedItem.index < target.index) {
      index -= 1;
    }
    return Math.max(0, index);
  }

  function showContextMenu(item, clientX, clientY) {
    if (!contextMenu) {
      return;
    }

    contextMenu.replaceChildren();
    contextMenu.append(
      createContextAction("Open in New Tab", () => openItem(item, "tab"), !item.url),
      createContextAction("Open in New Window", () => openItem(item, "window"), !item.url),
      createContextSeparator(),
      createContextAction(`Delete ${item.type === "folder" ? "Folder" : "Bookmark"}`, () => removeItem(item))
    );
    contextMenu.hidden = false;
    contextMenu.style.left = "0px";
    contextMenu.style.top = "0px";

    const rect = contextMenu.getBoundingClientRect();
    const padding = 8;
    const left = Math.min(clientX, document.documentElement.clientWidth - rect.width - padding);
    const top = Math.min(clientY, document.documentElement.clientHeight - rect.height - padding);
    contextMenu.style.left = `${Math.max(padding, left) / layoutScale}px`;
    contextMenu.style.top = `${Math.max(padding, top) / layoutScale}px`;
  }

  function createContextAction(label, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hoverbar-context-action";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", () => {
      hideContextMenu();
      action();
    });
    return button;
  }

  function createContextSeparator() {
    const separator = document.createElement("div");
    separator.className = "hoverbar-context-separator";
    separator.setAttribute("role", "separator");
    return separator;
  }

  function hideContextMenu() {
    if (contextMenu) {
      contextMenu.hidden = true;
    }
  }

  function resetTransientState() {
    if (alwaysVisible) {
      return;
    }

    window.clearTimeout(closeTimer);
    window.clearTimeout(hoverTimer);
    cancelDragOpen();
    closeTimer = null;
    hoverTimer = null;
    draggedItem = null;
    openMenuPath = [];
    hoverVisible = false;
    hoverSuppressed = false;
    chromeHoverHold = false;
    hideContextMenu();
    clearDropTargets();
    shell.classList.remove("menus-open", "grace-open", "suppress-open");
    renderPopups();
  }

  async function openItem(item, where) {
    if (!item.url) {
      return;
    }

    await browser.runtime.sendMessage({
      type: "hoverbar:open-bookmark",
      payload: {
        url: item.url,
        where
      }
    });
    suppressHoverUntilTopReentry();
  }

  async function removeItem(item) {
    const confirmed = window.confirm(`Delete ${item.type === "folder" ? "folder" : "bookmark"} "${item.title}"?`);
    if (!confirmed) {
      return;
    }

    await browser.runtime.sendMessage({
      type: "hoverbar:remove-bookmark",
      payload: {
        id: item.id,
        type: item.type
      }
    });
    closeMenus();
  }

  function buildIcon(item) {
    const iconWrap = document.createElement("span");
    iconWrap.className = "hoverbar-icon-wrap";

    if (item.type === "folder") {
      iconWrap.classList.add("hoverbar-folder-icon-wrap");
      iconWrap.append(...buildFolderIconParts(item));
      return iconWrap;
    }

    const img = document.createElement("img");
    img.className = "hoverbar-icon";
    img.alt = "";
    const candidates = faviconCandidates(item.url, state?.faviconCache);
    if (candidates.length > 0) {
      img.src = candidates[0];
      img.dataset.index = "0";
      img.dataset.candidates = JSON.stringify(candidates);
      img.addEventListener("error", rotateFaviconSource);
    } else {
      img.hidden = true;
    }

    const fallback = document.createElement("span");
    fallback.className = "hoverbar-fallback-icon";
    fallback.setAttribute("aria-hidden", "true");
    fallback.hidden = Boolean(img.src);
    fallback.textContent = fallbackInitial(item);

    if (img.src) {
      img.addEventListener("load", () => {
        img.hidden = false;
        fallback.hidden = true;
        cacheFavicon(item.url, img.currentSrc || img.src);
      });
    }

    iconWrap.append(img, fallback);
    return iconWrap;
  }

  function buildFolderIconParts(item) {
    const emoji = singleEmoji(item.title);
    const mode = state?.settings?.folderIconMode || "emoji";

    if (emoji && mode === "emoji") {
      return [createFolderEmoji(emoji)];
    }

    const folder = createFolderGlyph();
    if (emoji && mode === "both") {
      return [folder, createFolderEmoji(emoji, true)];
    }

    return [folder];
  }

  function createFolderGlyph() {
    const folder = document.createElement("span");
    folder.className = "hoverbar-folder-glyph";
    folder.setAttribute("aria-hidden", "true");
    if (state?.settings?.folderColor) {
      folder.style.setProperty("--hoverbar-folder-color", state.settings.folderColor);
      folder.style.backgroundColor = state.settings.folderColor;
    }

    const tab = document.createElement("span");
    tab.className = "hoverbar-folder-tab";
    if (state?.settings?.folderColor) {
      tab.style.backgroundColor = state.settings.folderColor;
    }
    folder.append(tab);
    return folder;
  }

  function createFolderEmoji(emoji, badge = false) {
    const element = document.createElement("span");
    element.className = badge ? "hoverbar-folder-emoji hoverbar-folder-emoji-badge" : "hoverbar-folder-emoji";
    element.setAttribute("aria-hidden", "true");
    element.textContent = emoji;
    return element;
  }

  function buildLabel(title, inMenu = false) {
    const label = document.createElement("span");
    label.className = inMenu ? "hoverbar-label hoverbar-label-menu" : "hoverbar-label";
    label.textContent = title;
    return label;
  }

  function rotateFaviconSource(event) {
    const img = event.currentTarget;
    const fallback = img.nextElementSibling;
    const candidates = JSON.parse(img.dataset.candidates || "[]");
    const currentIndex = Number(img.dataset.index || 0);
    const nextIndex = currentIndex + 1;

    if (nextIndex >= candidates.length) {
      img.hidden = true;
      if (fallback) {
        fallback.hidden = false;
      }
      return;
    }

    if (fallback) {
      fallback.hidden = true;
    }
    img.dataset.index = String(nextIndex);
    img.src = candidates[nextIndex];
  }

  function cacheFavicon(url, href) {
    try {
      const host = new URL(url).hostname;
      browser.runtime.sendMessage({
        type: "hoverbar:cache-favicon",
        payload: { host, href }
      }).catch(() => {});
    } catch {
      // Ignore invalid bookmark URLs.
    }
  }

  function faviconCandidates(url, cache = {}) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) {
        return [];
      }

      const candidates = [
        cache?.[parsed.hostname]?.startsWith("data:image/") ? cache[parsed.hostname] : null
      ];

      return candidates.filter(Boolean);
    } catch {
      return [];
    }
  }

  function fallbackInitial(item) {
    const source = item.title || friendlyHostname(item.url);
    return source.trim().slice(0, 1).toUpperCase() || "?";
  }

  function friendlyHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function singleEmoji(value) {
    const title = (value || "").trim();
    if (!title) {
      return null;
    }

    const graphemes = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title), (part) => part.segment)
      : Array.from(title);

    if (graphemes.length !== 1) {
      return null;
    }

    return /\p{Extended_Pictographic}/u.test(graphemes[0]) ? graphemes[0] : null;
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
      hideContextMenu();
      closeMenus();
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      const path = event.composedPath();
      if (!path.includes(contextMenu)) {
        hideContextMenu();
      }
    },
    true
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
      closeMenus();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resetTransientState();
    }
  });

  window.addEventListener("blur", resetTransientState);
  window.addEventListener("pagehide", resetTransientState);

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

  document.addEventListener(
    "dragover",
    (event) => {
      if (!draggedItem) {
        return;
      }

      syncDragOpenToPoint(event.clientX, event.clientY);
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
    setSettingsVars(state.settings);
    setZoomVars(state.zoom);
    render();
  });

  state = await browser.runtime.sendMessage({ type: "hoverbar:get-state" });
  setThemeVars(state.theme);
  setSettingsVars(state.settings);
  setZoomVars(state.zoom);
  render();
}
