const DEFAULT_SETTINGS = {
  showNames: false,
  showFolderNames: true,
  folderColor: "",
  folderIconMode: "emoji",
  faviconCache: {}
};

const TOOLBAR_ROOT_ID = "toolbar_____";
const faviconWarmups = new Set();
let faviconBroadcastTimer = null;

browser.runtime.onInstalled.addListener(async () => {
  const current = await browser.storage.local.get(DEFAULT_SETTINGS);
  await browser.storage.local.set({ ...DEFAULT_SETTINGS, ...current });
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

  if (message.type === "hoverbar:remove-bookmark") {
    return removeBookmark(message.payload);
  }

  if (message.type === "hoverbar:open-bookmark") {
    return openBookmark(message.payload, sender.tab?.windowId);
  }

  if (message.type === "hoverbar:cache-favicon") {
    return cacheFavicon(message.payload);
  }

  return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (!changes.showNames && !changes.showFolderNames && !changes.folderColor && !changes.folderIconMode)
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
      broadcastTabState(zoomChangeInfo.tabId);
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
  const tabs = await browser.tabs.query(windowId ? { windowId } : {});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }

      try {
        const state = await buildState(tab.windowId, tab.id);
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

async function buildState(windowId, tabId) {
  const [settings, items, theme, zoom] = await Promise.all([
    browser.storage.local.get(DEFAULT_SETTINGS),
    loadToolbarItems(),
    loadTheme(windowId),
    loadZoom(tabId)
  ]);

  const faviconCache = sanitizeFaviconCache(settings.faviconCache);
  warmFaviconCache(items, faviconCache);

  return {
    settings: {
      showNames: Boolean(settings.showNames),
      showFolderNames: Boolean(settings.showFolderNames),
      folderColor: typeof settings.folderColor === "string" ? settings.folderColor : "",
      folderIconMode: normalizeFolderIconMode(settings.folderIconMode)
    },
    items,
    theme,
    zoom,
    faviconCache
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
    .filter((node) => node.type !== "separator")
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

  const destination = { parentId };
  if (Number.isInteger(index) && index >= 0) {
    destination.index = index;
  }

  await browser.bookmarks.move(id, destination);
  return { ok: true };
}

async function removeBookmark(payload) {
  const id = payload?.id;
  const type = payload?.type;

  if (typeof id !== "string") {
    return { ok: false };
  }

  if (type === "folder") {
    await browser.bookmarks.removeTree(id);
  } else {
    await browser.bookmarks.remove(id);
  }

  return { ok: true };
}

async function openBookmark(payload, fallbackWindowId) {
  const url = payload?.url;
  const where = payload?.where;

  if (typeof url !== "string" || !url) {
    return { ok: false };
  }

  if (where === "window") {
    await browser.windows.create({ url });
  } else {
    await browser.tabs.create({
      url,
      windowId: payload?.windowId || fallbackWindowId
    });
  }

  return { ok: true };
}

async function cacheFavicon(payload) {
  const host = payload?.host;
  const href = payload?.href;

  if (typeof host !== "string" || typeof href !== "string" || !host || !href) {
    return { ok: false };
  }

  const { faviconCache = {} } = await browser.storage.local.get({ faviconCache: {} });
  const sanitizedCache = sanitizeFaviconCache(faviconCache);
  if (sanitizedCache[host] === href) {
    return { ok: true };
  }

  await browser.storage.local.set({
    faviconCache: {
      ...sanitizedCache,
      [host]: href
    }
  });
  return { ok: true };
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

  let href = favIconUrl;
  if (/^https?:\/\//.test(favIconUrl)) {
    href = await fetchFaviconDataUrl(favIconUrl);
  } else if (!/^data:image\//.test(favIconUrl)) {
    return;
  }

  await cacheFavicon({
    host: parsedTabUrl.hostname,
    href
  });
  scheduleFaviconBroadcast();
}

function warmFaviconCache(items, cache) {
  const bookmarkUrls = collectBookmarkUrls(items);
  let started = 0;
  for (const url of bookmarkUrls) {
    if (started >= 8) {
      return;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    if (!/^https?:$/.test(parsed.protocol) || cache[parsed.hostname]?.startsWith("data:image/") || faviconWarmups.has(parsed.hostname)) {
      continue;
    }

    faviconWarmups.add(parsed.hostname);
    started += 1;
    fetchAndCacheFavicon(parsed).finally(() => {
      faviconWarmups.delete(parsed.hostname);
    });
  }
}

function collectBookmarkUrls(items, urls = []) {
  for (const item of items ?? []) {
    if (item.url) {
      urls.push(item.url);
    }
    collectBookmarkUrls(item.children, urls);
  }
  return urls;
}

async function fetchAndCacheFavicon(parsedUrl) {
  const candidates = [
    `${parsedUrl.origin}/favicon.ico`,
    `${parsedUrl.origin}/apple-touch-icon.png`,
    `${parsedUrl.origin}/apple-touch-icon-precomposed.png`
  ];

  for (const href of candidates) {
    try {
      const dataUrl = await fetchFaviconDataUrl(href);
      await cacheFavicon({
        host: parsedUrl.hostname,
        href: dataUrl
      });
      scheduleFaviconBroadcast();
      return;
    } catch {
      // Try the next common site-owned favicon URL.
    }
  }
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
      typeof host === "string" &&
      typeof href === "string" &&
      (/^https?:\/\//.test(href) || /^data:image\//.test(href)) &&
      !href.includes("icons.duckduckgo.com")
    ))
  );
}

function normalizeFolderIconMode(value) {
  return ["emoji", "folder", "both"].includes(value) ? value : "emoji";
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
