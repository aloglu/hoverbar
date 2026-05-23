const DEFAULT_SETTINGS = {
  showNames: false,
  showFolderNames: true,
  folderColor: "",
  folderIconMode: "emoji",
  showNewtabBar: true,
  iconSizePreset: "default",
  resizeFolderMenuIcons: true,
  bookmarkOpenBehavior: "current-tab",
  barPosition: "top",
  spacingPreset: "default",
  faviconCache: {}
};

const TOOLBAR_ROOT_ID = "toolbar_____";
const MAX_FAVICON_CACHE_ENTRIES = 256;
const MAX_FAVICON_DATA_URL_LENGTH = 96 * 1024;
let faviconBroadcastTimer = null;

browser.runtime.onInstalled.addListener(async () => {
  const current = await browser.storage.local.get(DEFAULT_SETTINGS);
  await browser.storage.local.set({
    ...DEFAULT_SETTINGS,
    ...current,
    faviconCache: pruneFaviconCache(sanitizeFaviconCache(current.faviconCache))
  });
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "hoverbar:get-state") {
    const windowId = sender.tab?.windowId ?? browser.windows.WINDOW_ID_CURRENT;
    return buildState(windowId, sender.tab?.id);
  }

  if (message.type === "hoverbar:move-bookmark") {
    return moveBookmark(message.payload);
  }

  if (message.type === "hoverbar:update-bookmark") {
    return updateBookmark(message.payload);
  }

  if (message.type === "hoverbar:create-separator") {
    return createSeparator(message.payload);
  }

  if (message.type === "hoverbar:remove-bookmark") {
    return removeBookmark(message.payload);
  }

  if (message.type === "hoverbar:open-bookmark") {
    return openBookmark(message.payload, sender.tab?.windowId, sender.tab?.id);
  }

  if (message.type === "hoverbar:cache-favicon") {
    return cacheFavicon(message.payload);
  }

  return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (
      !changes.showNames &&
      !changes.showFolderNames &&
      !changes.folderColor &&
      !changes.folderIconMode &&
      !changes.showNewtabBar &&
      !changes.iconSizePreset &&
      !changes.resizeFolderMenuIcons &&
      !changes.bookmarkOpenBehavior &&
      !changes.barPosition &&
      !changes.spacingPreset
    )
  ) {
    return;
  }

  broadcastState();
});

browser.bookmarks.onCreated.addListener(() => {
  broadcastState();
});

browser.bookmarks.onRemoved.addListener(() => {
  broadcastState();
});

browser.bookmarks.onChanged.addListener(() => {
  broadcastState();
});

browser.bookmarks.onMoved.addListener(() => {
  broadcastState();
});

browser.theme.onUpdated.addListener((updateInfo) => {
  broadcastState(updateInfo.windowId);
});

if (browser.tabs.onZoomChange) {
  browser.tabs.onZoomChange.addListener((zoomChangeInfo) => {
    if (zoomChangeInfo.tabId) {
      broadcastTabZoom(zoomChangeInfo.tabId, zoomChangeInfo.newZoomFactor);
    }
  });
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const favIconUrl = changeInfo.favIconUrl || tab.favIconUrl;
  if (!favIconUrl) {
    return;
  }

  cacheTabFavicon(tab.url, favIconUrl).catch((error) => {
    console.warn("Hoverbar tab favicon cache failed", error);
  });
});

async function broadcastState(windowId) {
  let tabs;
  let baseState;
  try {
    [tabs, baseState] = await Promise.all([
      browser.tabs.query(windowId ? { windowId } : {}),
      buildBaseState()
    ]);
  } catch (error) {
    console.warn("Hoverbar state broadcast failed", error);
    return;
  }

  const themeByWindowId = new Map();
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }

      try {
        const state = await completeState(baseState, tab.windowId, tab.id, themeByWindowId);
        await browser.tabs.sendMessage(tab.id, {
          type: "hoverbar:update",
          payload: state
        });
      } catch (error) {
        if (!`${error}`.includes("Receiving end does not exist")) {
          console.warn("Hoverbar update failed", error);
        }
      }
    })
  );
}

async function broadcastTabState(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    const state = await buildState(tab.windowId, tab.id);
    await browser.tabs.sendMessage(tab.id, {
      type: "hoverbar:update",
      payload: state
    });
  } catch (error) {
    if (!`${error}`.includes("Receiving end does not exist")) {
      console.warn("Hoverbar tab update failed", error);
    }
  }
}

async function broadcastTabZoom(tabId, zoom) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "hoverbar:zoom",
      payload: { zoom }
    });
  } catch (error) {
    if (!`${error}`.includes("Receiving end does not exist")) {
      console.warn("Hoverbar zoom update failed", error);
    }
  }
}

async function buildState(windowId, tabId) {
  return completeState(await buildBaseState(), windowId, tabId);
}

async function buildBaseState() {
  const [settings, items] = await Promise.all([
    browser.storage.local.get(DEFAULT_SETTINGS),
    loadToolbarItems()
  ]);

  const faviconCache = filterFaviconCacheForItems(items, sanitizeFaviconCache(settings.faviconCache));

  return {
    settings: {
      showNames: Boolean(settings.showNames),
      showFolderNames: Boolean(settings.showFolderNames),
      folderColor: typeof settings.folderColor === "string" ? settings.folderColor : "",
      folderIconMode: normalizeFolderIconMode(settings.folderIconMode),
      showNewtabBar: settings.showNewtabBar !== false,
      iconSizePreset: normalizeIconSizePreset(settings.iconSizePreset),
      resizeFolderMenuIcons: settings.resizeFolderMenuIcons !== false,
      bookmarkOpenBehavior: normalizeBookmarkOpenBehavior(settings.bookmarkOpenBehavior),
      barPosition: normalizeBarPosition(settings.barPosition),
      spacingPreset: normalizeSpacingPreset(settings.spacingPreset)
    },
    items,
    faviconCache
  };
}

async function completeState(baseState, windowId, tabId, themeByWindowId = new Map()) {
  const themeKey = Number.isInteger(windowId) ? windowId : browser.windows.WINDOW_ID_CURRENT;
  const themePromise = themeByWindowId.get(themeKey) || loadTheme(themeKey);
  themeByWindowId.set(themeKey, themePromise);

  const [theme, zoom] = await Promise.all([
    themePromise,
    loadZoom(tabId)
  ]);

  return {
    ...baseState,
    theme,
    zoom
  };
}

async function loadToolbarItems() {
  try {
    const subtree = await browser.bookmarks.getSubTree(TOOLBAR_ROOT_ID);
    const root = subtree?.[0];
    return sanitizeNodes(root?.children ?? []);
  } catch (error) {
    const tree = await browser.bookmarks.getTree();
    const toolbarNode = findNode(tree, TOOLBAR_ROOT_ID);
    return sanitizeNodes(toolbarNode?.children ?? []);
  }
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

function sanitizeNodes(nodes) {
  return (nodes ?? [])
    .filter(Boolean)
    .map((node) => {
      const base = {
        id: node.id,
        parentId: node.parentId || null,
        index: Number.isInteger(node.index) ? node.index : null,
        title: "",
        url: null,
        type: "separator",
        children: []
      };

      if (node.type === "separator") {
        return base;
      }

      return {
        ...base,
        title: node.title || friendlyTitle(node.url),
        url: node.url || null,
        type: node.url ? "bookmark" : "folder",
        children: node.url ? [] : sanitizeNodes(node.children)
      };
    });
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

async function loadTheme(windowId) {
  const theme = await browser.theme.getCurrent(windowId);
  const colors = theme?.colors ?? {};
  const background = firstColor(colors.toolbar, colors.frame, colors.popup);
  const foreground = firstColor(colors.toolbar_text, colors.tab_text, colors.popup_text);
  const border = firstColor(colors.toolbar_field_border, colors.popup_border, foreground ? withAlpha(foreground, 0.18) : null);
  const shadow = background ? (isDark(background) ? "rgba(0, 0, 0, 0.45)" : "rgba(15, 23, 42, 0.18)") : null;
  const mode = theme?.properties?.color_scheme || theme?.properties?.content_color_scheme || (background ? (isDark(background) ? "dark" : "light") : null);

  return {
    background,
    foreground,
    border,
    shadow,
    mode
  };
}

async function loadZoom(tabId) {
  if (!tabId || !browser.tabs.getZoom) {
    return 1;
  }

  try {
    return await browser.tabs.getZoom(tabId);
  } catch {
    return 1;
  }
}

async function moveBookmark(payload) {
  const id = payload?.id;
  const parentId = payload?.parentId;
  const index = payload?.index;

  if (typeof id !== "string" || typeof parentId !== "string" || id === parentId) {
    return { ok: false };
  }

  const items = await loadToolbarItems();
  const item = findItemById(items, id);
  if (!item || !canUseBookmarkParent(items, parentId)) {
    return { ok: false };
  }

  const destination = { parentId };
  if (Number.isInteger(index) && index >= 0) {
    destination.index = index;
  }

  await browser.bookmarks.move(id, destination);
  return { ok: true };
}

async function updateBookmark(payload) {
  const id = payload?.id;

  if (typeof id !== "string") {
    return { ok: false };
  }

  const item = findItemById(await loadToolbarItems(), id);
  if (!item || item.type === "separator") {
    return { ok: false };
  }

  const changes = {};
  if (typeof payload.title === "string") {
    changes.title = payload.title.trim();
  }

  if (item.type === "bookmark") {
    if (typeof payload.url !== "string" || !payload.url.trim()) {
      return { ok: false };
    }
    changes.url = payload.url.trim();
  }

  if (!Object.keys(changes).length) {
    return { ok: false };
  }

  await browser.bookmarks.update(id, changes);
  return { ok: true };
}

async function createSeparator(payload) {
  const parentId = payload?.parentId;
  const index = payload?.index;

  if (typeof parentId !== "string") {
    return { ok: false };
  }

  const items = await loadToolbarItems();
  if (!canUseBookmarkParent(items, parentId)) {
    return { ok: false };
  }

  const createDetails = {
    type: "separator",
    parentId
  };
  if (Number.isInteger(index) && index >= 0) {
    createDetails.index = index;
  }

  await browser.bookmarks.create(createDetails);
  return { ok: true };
}

async function removeBookmark(payload) {
  const id = payload?.id;

  if (typeof id !== "string") {
    return { ok: false };
  }

  const item = findItemById(await loadToolbarItems(), id);
  if (!item) {
    return { ok: false };
  }

  if (item.type === "folder") {
    await browser.bookmarks.removeTree(id);
  } else {
    await browser.bookmarks.remove(id);
  }

  return { ok: true };
}

async function openBookmark(payload, fallbackWindowId, fallbackTabId) {
  const url = payload?.url;
  const where = payload?.where;

  if (typeof url !== "string" || !url) {
    return { ok: false };
  }

  if (!bookmarkUrlExists(await loadToolbarItems(), url)) {
    return { ok: false };
  }

  if (where === "current") {
    const tabId = Number.isInteger(payload?.tabId) ? payload.tabId : fallbackTabId;
    if (!Number.isInteger(tabId)) {
      return { ok: false };
    }
    await browser.tabs.update(tabId, { url });
  } else if (where === "window") {
    await browser.windows.create({ url });
  } else {
    const createProperties = { url };
    const windowId = payload?.windowId || fallbackWindowId;
    if (Number.isInteger(windowId)) {
      createProperties.windowId = windowId;
    }
    await browser.tabs.create(createProperties);
  }

  return { ok: true };
}

async function cacheFavicon(payload) {
  const host = normalizeFaviconKey(payload?.host);
  const href = payload?.href;

  if (!host || typeof href !== "string" || !isAllowedFaviconHref(href)) {
    return { ok: false };
  }

  if (!collectBookmarkFaviconKeys(await loadToolbarItems()).has(host)) {
    return { ok: false };
  }

  const { faviconCache = {} } = await browser.storage.local.get({ faviconCache: {} });
  const sanitizedCache = sanitizeFaviconCache(faviconCache);
  if (sanitizedCache[host] === href) {
    return { ok: true, changed: false };
  }

  delete sanitizedCache[host];
  sanitizedCache[host] = href;

  await browser.storage.local.set({
    faviconCache: pruneFaviconCache(sanitizedCache)
  });
  return { ok: true, changed: true };
}

async function cacheTabFavicon(tabUrl, favIconUrl) {
  let parsedTabUrl;
  try {
    parsedTabUrl = new URL(tabUrl);
  } catch {
    return;
  }

  if (!/^https?:$/.test(parsedTabUrl.protocol) || typeof favIconUrl !== "string") {
    return;
  }

  if (!collectBookmarkFaviconKeys(await loadToolbarItems()).has(faviconKeyFromUrl(parsedTabUrl))) {
    return;
  }

  let href = favIconUrl;
  if (/^https?:\/\//.test(favIconUrl)) {
    href = await fetchFaviconDataUrl(favIconUrl);
  } else if (!/^data:image\//.test(favIconUrl)) {
    return;
  }

  const result = await cacheFavicon({
    host: faviconKeyFromUrl(parsedTabUrl),
    href
  });
  if (result.changed) {
    scheduleFaviconBroadcast();
  }
}

function collectBookmarkFaviconKeys(items, hosts = new Set()) {
  for (const item of items ?? []) {
    if (item.url) {
      try {
        const parsed = new URL(item.url);
        if (/^https?:$/.test(parsed.protocol)) {
          hosts.add(faviconKeyFromUrl(parsed));
        }
      } catch {
        // Ignore invalid bookmark URLs.
      }
    }
    collectBookmarkFaviconKeys(item.children, hosts);
  }
  return hosts;
}

function findItemById(items, id) {
  for (const item of items ?? []) {
    if (item.id === id) {
      return item;
    }

    const child = findItemById(item.children, id);
    if (child) {
      return child;
    }
  }

  return null;
}

function canUseBookmarkParent(items, parentId) {
  return parentId === TOOLBAR_ROOT_ID || findItemById(items, parentId)?.type === "folder";
}

function bookmarkUrlExists(items, url) {
  for (const item of items ?? []) {
    if (item.url === url || bookmarkUrlExists(item.children, url)) {
      return true;
    }
  }

  return false;
}

async function fetchFaviconDataUrl(href) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3500);

  try {
    const response = await fetch(href, {
      cache: "force-cache",
      credentials: "omit",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Favicon request failed: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "image/x-icon";
    if (!contentType.startsWith("image/")) {
      throw new Error(`Unexpected favicon content type: ${contentType}`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 65536) {
      throw new Error("Favicon is too large to cache");
    }

    return `data:${contentType.split(";")[0]};base64,${arrayBufferToBase64(buffer)}`;
  } finally {
    clearTimeout(timeout);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function scheduleFaviconBroadcast() {
  clearTimeout(faviconBroadcastTimer);
  faviconBroadcastTimer = setTimeout(() => {
    broadcastState();
  }, 800);
}

function sanitizeFaviconCache(cache) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(cache).filter(([host, href]) => (
      normalizeFaviconKey(host) === host &&
      isAllowedFaviconHref(href)
    ))
  );
}

function filterFaviconCacheForItems(items, cache) {
  const hosts = collectBookmarkFaviconKeys(items);
  const legacyHosts = collectBookmarkLegacyFaviconKeys(items);
  return Object.fromEntries(
    Object.entries(cache).filter(([host]) => hosts.has(host) || legacyHosts.has(host))
  );
}

function pruneFaviconCache(cache) {
  const entries = Object.entries(cache);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_FAVICON_CACHE_ENTRIES)));
}

function normalizeFaviconKey(host) {
  if (typeof host !== "string" || !host) {
    return "";
  }

  try {
    return new URL(`https://${host}`).host;
  } catch {
    return "";
  }
}

function faviconKeyFromUrl(url) {
  return url.host;
}

function collectBookmarkLegacyFaviconKeys(items, hosts = new Set()) {
  for (const item of items ?? []) {
    if (item.url) {
      try {
        const parsed = new URL(item.url);
        if (/^https?:$/.test(parsed.protocol) && !parsed.port) {
          hosts.add(parsed.hostname);
        }
      } catch {
        // Ignore invalid bookmark URLs.
      }
    }
    collectBookmarkLegacyFaviconKeys(item.children, hosts);
  }
  return hosts;
}

function isAllowedFaviconHref(href) {
  return (
    typeof href === "string" &&
    (/^https?:\/\//.test(href) || /^data:image\//.test(href)) &&
    href.length <= MAX_FAVICON_DATA_URL_LENGTH &&
    !href.includes("icons.duckduckgo.com")
  );
}

function normalizeFolderIconMode(value) {
  return ["emoji", "folder", "both"].includes(value) ? value : "emoji";
}

function normalizeIconSizePreset(value) {
  return ["small", "default", "large"].includes(value) ? value : "default";
}

function normalizeBookmarkOpenBehavior(value) {
  return ["current-tab", "new-tab"].includes(value) ? value : "current-tab";
}

function normalizeBarPosition(value) {
  return ["top", "bottom", "left", "right"].includes(value) ? value : "top";
}

function normalizeSpacingPreset(value) {
  return ["compact", "default", "comfortable"].includes(value) ? value : "default";
}

function firstColor(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || null;
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
