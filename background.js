const DEFAULT_SETTINGS = {
  showNames: false,
  showFolderNames: true
};

const TOOLBAR_ROOT_ID = "toolbar_____";

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
    return buildState(windowId);
  }

  return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (!changes.showNames && !changes.showFolderNames && Object.keys(changes).length === 0)
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

async function broadcastState(windowId) {
  const tabs = await browser.tabs.query(windowId ? { windowId } : {});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }

      try {
        const state = await buildState(tab.windowId);
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

async function buildState(windowId) {
  const [settings, items, theme] = await Promise.all([
    browser.storage.local.get(DEFAULT_SETTINGS),
    loadToolbarItems(),
    loadTheme(windowId)
  ]);

  return {
    settings: {
      showNames: Boolean(settings.showNames),
      showFolderNames: Boolean(settings.showFolderNames)
    },
    items,
    theme
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
