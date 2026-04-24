const TOOLBAR_ROOT_ID = "toolbar_____";
const DEFAULT_SETTINGS = {
  showNames: false,
  showFolderNames: true,
  folderColor: "",
  folderIconMode: "emoji",
  faviconCache: {}
};

init().catch((error) => {
  console.error("Hoverbar new tab failed", error);
});

async function init() {
  const shell = document.querySelector(".newtab-shell");
  const scrollContainer = document.querySelector(".newtab-scroll");
  const itemsContainer = document.querySelector(".newtab-items");
  const popupLayer = document.querySelector(".newtab-popups");
  const contextMenu = document.querySelector(".newtab-context-menu");

  let state = null;
  let openMenuPath = [];
  let anchorMap = new Map();
  let itemMap = new Map();
  let closeTimer = null;
  let draggedItem = null;
  let dragOpenTimer = null;
  let dragOpenTargetId = null;
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
    for (const button of document.querySelectorAll("[data-path-key]")) {
      button.setAttribute("aria-expanded", String(openMenuPath.includes(button.dataset.pathKey)));
    }
    renderPopups();
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
    if (draggedItem) {
      return;
    }

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
    itemMap = buildItemMap(state.items);
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
    setItemDataset(button, item);
    button.title = item.title;
    button.append(buildIcon(item), buildLabel(item.title));
    anchorMap.set(pathKey, button);
    button.addEventListener("mouseenter", () => setOpenMenuPath(buildPathChain(pathKey)));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setOpenMenuPath(openMenuPath.includes(pathKey) ? [] : buildPathChain(pathKey));
    });
    bindItemInteractions(button, item);
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
        setItemDataset(button, child);
        button.title = child.title;
        button.append(buildIcon(child), buildLabel(child.title, true));
        anchorMap.set(pathKey, button);
        button.addEventListener("mouseenter", () => setOpenMenuPath(buildPathChain(pathKey)));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpenMenuPath(openMenuPath.includes(pathKey) ? buildPathChain(parentPath) : buildPathChain(pathKey));
        });
        bindItemInteractions(button, child);
        row.append(button);
      }

      menu.append(row);
    });

    bindMenuInteractions(menu);
    return menu;
  }

  function renderPopups() {
    for (const menu of popupLayer.querySelectorAll(".newtab-menu")) {
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
    setItemDataset(anchor, item);
    anchor.append(buildIcon(item), buildLabel(item.title, inMenu));
    anchor.addEventListener("click", () => {
      setOpenMenuPath([]);
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
    for (const button of document.querySelectorAll(".newtab-folder[data-path-key]")) {
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
    const horizontal = !event.currentTarget.closest(".newtab-menu");
    const coordinate = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const size = horizontal ? rect.width : rect.height;

    if (coordinate < size * 0.28) {
      return "before";
    }

    if (coordinate > size * 0.72) {
      return "after";
    }

    return target.type === "folder" ? "inside" : "after";
  }

  function markDropTarget(element, operation) {
    clearDropTargets();
    element.classList.add(`drop-${operation}`);
  }

  function clearDropTargets() {
    for (const element of document.querySelectorAll(".drop-before, .drop-after, .drop-inside")) {
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
    contextMenu.style.left = `${Math.max(padding, left)}px`;
    contextMenu.style.top = `${Math.max(padding, top)}px`;
  }

  function createContextAction(label, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "newtab-context-action";
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
    separator.className = "newtab-context-separator";
    separator.setAttribute("role", "separator");
    return separator;
  }

  function hideContextMenu() {
    if (contextMenu) {
      contextMenu.hidden = true;
    }
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
    setOpenMenuPath([]);
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
    setOpenMenuPath([]);
  }

  function buildIcon(item) {
    const iconWrap = document.createElement("span");
    iconWrap.className = "newtab-icon-wrap";

    if (item.type === "folder") {
      iconWrap.classList.add("newtab-folder-icon-wrap");
      iconWrap.append(...buildFolderIconParts(item));
      return iconWrap;
    }

    const img = document.createElement("img");
    img.className = "newtab-icon";
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
    fallback.className = "newtab-fallback-icon";
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
    folder.className = "newtab-folder-glyph";
    folder.setAttribute("aria-hidden", "true");
    if (state?.settings?.folderColor) {
      folder.style.setProperty("--hoverbar-folder-color", state.settings.folderColor);
      folder.style.backgroundColor = state.settings.folderColor;
    }

    const tab = document.createElement("span");
    tab.className = "newtab-folder-tab";
    if (state?.settings?.folderColor) {
      tab.style.backgroundColor = state.settings.folderColor;
    }
    folder.append(tab);
    return folder;
  }

  function createFolderEmoji(emoji, badge = false) {
    const element = document.createElement("span");
    element.className = badge ? "newtab-folder-emoji newtab-folder-emoji-badge" : "newtab-folder-emoji";
    element.setAttribute("aria-hidden", "true");
    element.textContent = emoji;
    return element;
  }

  function buildLabel(title, inMenu = false) {
    const label = document.createElement("span");
    label.className = inMenu ? "newtab-label newtab-label-menu" : "newtab-label";
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
    setVar("--hoverbar-folder-color", state.settings.folderColor);
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
        showFolderNames: Boolean(settings.showFolderNames),
        folderColor: typeof settings.folderColor === "string" ? settings.folderColor : "",
        folderIconMode: normalizeFolderIconMode(settings.folderIconMode)
      },
      items: sanitizeNodes(subtree?.[0]?.children ?? []),
      theme: buildTheme(theme),
      faviconCache: sanitizeFaviconCache(settings.faviconCache)
    };
  }

  function sanitizeFaviconCache(cache) {
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(cache).filter(([host, href]) => (
        typeof host === "string" &&
        typeof href === "string" &&
        (/^https?:\/\//.test(href) || /^data:image\//.test(href))
      ))
    );
  }

  function normalizeFolderIconMode(value) {
    return ["emoji", "folder", "both"].includes(value) ? value : "emoji";
  }

  function sanitizeNodes(nodes) {
    return (nodes ?? [])
      .filter((node) => node && node.type !== "separator")
      .map((node) => ({
        id: node.id,
        parentId: node.parentId || null,
        index: Number.isInteger(node.index) ? node.index : null,
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
    hideContextMenu();
    if (!event.composedPath().some((node) => node instanceof Element && node.closest?.(".newtab-shell"))) {
      closeMenus();
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.composedPath().includes(contextMenu)) {
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

  browser.bookmarks.onCreated.addListener(async () => {
    await loadState();
    setThemeVars(state.theme);
    render();
  });
  browser.bookmarks.onRemoved.addListener(async () => {
    await loadState();
    setThemeVars(state.theme);
    render();
  });
  browser.bookmarks.onChanged.addListener(async () => {
    await loadState();
    setThemeVars(state.theme);
    render();
  });
  browser.bookmarks.onMoved.addListener(async () => {
    await loadState();
    setThemeVars(state.theme);
    render();
  });
  browser.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local" || (!changes.showNames && !changes.showFolderNames && !changes.folderColor && !changes.folderIconMode)) {
      return;
    }
    await loadState();
    setThemeVars(state.theme);
    render();
  });
  browser.theme.onUpdated.addListener(async () => {
    await loadState();
    setThemeVars(state.theme);
    render();
  });

  await loadState();
  setThemeVars(state.theme);
  render();
}
