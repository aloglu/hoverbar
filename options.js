const checkbox = document.getElementById("show-names");
const folderCheckbox = document.getElementById("show-folder-names");
const newtabBarCheckbox = document.getElementById("show-newtab-bar");
const folderColorSwatch = document.getElementById("folder-color-swatch");
const folderColorText = document.getElementById("folder-color-text");
const folderIconMode = document.getElementById("folder-icon-mode");
const iconSizePreset = document.getElementById("icon-size-preset");
const resizeFolderMenuIcons = document.getElementById("resize-folder-menu-icons");
const bookmarkOpenBehavior = document.getElementById("bookmark-open-behavior");
const barPosition = document.getElementById("bar-position");
const spacingPreset = document.getElementById("spacing-preset");

init().catch((error) => {
  console.error("Hoverbar options failed to load", error);
});

if (browser.theme?.onUpdated) {
  browser.theme.onUpdated.addListener(() => {
    applyTheme().catch((error) => {
      console.warn("Hoverbar options theme update failed", error);
    });
  });
}

checkbox.addEventListener("change", async () => {
  await save();
});

folderCheckbox.addEventListener("change", async () => {
  await save();
});

newtabBarCheckbox.addEventListener("change", async () => {
  await save();
});

folderColorText.addEventListener("input", async () => {
  const normalized = normalizeColor(folderColorText.value);
  if (!folderColorText.value.trim()) {
    updateFolderColorSwatch("");
    await save();
    return;
  }

  if (!normalized) {
    return;
  }

  folderColorText.value = normalized.toUpperCase();
  updateFolderColorSwatch(normalized);
  await save();
});

folderIconMode.addEventListener("change", async () => {
  await save();
});

iconSizePreset.addEventListener("change", async () => {
  await save();
});

resizeFolderMenuIcons.addEventListener("change", async () => {
  await save();
});

bookmarkOpenBehavior.addEventListener("change", async () => {
  await save();
});

barPosition.addEventListener("change", async () => {
  await save();
});

spacingPreset.addEventListener("change", async () => {
  await save();
});

async function init() {
  const [{
    showNames = false,
    showFolderNames = true,
    showNewtabBar = true,
    folderColor: savedFolderColor = "",
    folderIconMode: savedFolderIconMode = "emoji",
    iconSizePreset: savedIconSizePreset = "default",
    resizeFolderMenuIcons: savedResizeFolderMenuIcons = true,
    bookmarkOpenBehavior: savedBookmarkOpenBehavior = "current-tab",
    barPosition: savedBarPosition = "top",
    spacingPreset: savedSpacingPreset = "default"
  }] = await Promise.all([
    browser.storage.local.get({
      showNames: false,
      showFolderNames: true,
      showNewtabBar: true,
      folderColor: "",
      folderIconMode: "emoji",
      iconSizePreset: "default",
      resizeFolderMenuIcons: true,
      bookmarkOpenBehavior: "current-tab",
      barPosition: "top",
      spacingPreset: "default"
    }),
    applyTheme()
  ]);

  checkbox.checked = showNames;
  folderCheckbox.checked = showFolderNames;
  newtabBarCheckbox.checked = showNewtabBar;
  folderColorText.value = normalizeColor(savedFolderColor);
  updateFolderColorSwatch(folderColorText.value);
  folderIconMode.value = normalizeFolderIconMode(savedFolderIconMode);
  iconSizePreset.value = normalizeIconSizePreset(savedIconSizePreset);
  resizeFolderMenuIcons.checked = savedResizeFolderMenuIcons;
  bookmarkOpenBehavior.value = normalizeBookmarkOpenBehavior(savedBookmarkOpenBehavior);
  barPosition.value = normalizeBarPosition(savedBarPosition);
  spacingPreset.value = normalizeSpacingPreset(savedSpacingPreset);
}

async function save() {
  const normalizedFolderColor = normalizeColor(folderColorText.value);

  await browser.storage.local.set({
    showNames: checkbox.checked,
    showFolderNames: folderCheckbox.checked,
    showNewtabBar: newtabBarCheckbox.checked,
    folderColor: normalizedFolderColor,
    folderIconMode: normalizeFolderIconMode(folderIconMode.value),
    iconSizePreset: normalizeIconSizePreset(iconSizePreset.value),
    resizeFolderMenuIcons: resizeFolderMenuIcons.checked,
    bookmarkOpenBehavior: normalizeBookmarkOpenBehavior(bookmarkOpenBehavior.value),
    barPosition: normalizeBarPosition(barPosition.value),
    spacingPreset: normalizeSpacingPreset(spacingPreset.value)
  });
}

function normalizeColor(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : "";
}

function updateFolderColorSwatch(value) {
  folderColorSwatch.style.backgroundColor = normalizeColor(value) || "#d0a21b";
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

async function applyTheme() {
  if (!browser.theme?.getCurrent) {
    return;
  }

  let theme;
  try {
    theme = await browser.theme.getCurrent();
  } catch (error) {
    console.warn("Hoverbar options theme load failed", error);
    return;
  }

  const root = document.documentElement;
  const colors = theme?.colors ?? {};
  const background = firstColor(colors.popup, colors.toolbar, colors.frame);
  const mode = theme?.properties?.color_scheme || theme?.properties?.content_color_scheme || (background ? (isDark(background) ? "dark" : "light") : null);

  if (mode) {
    root.style.colorScheme = mode;
  } else {
    root.style.removeProperty("color-scheme");
  }
}

function firstColor(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || null;
}

function withAlpha(color, alpha) {
  const rgb = parseColor(color);
  if (!rgb) {
    return null;
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

function readableText(background) {
  if (!background) {
    return null;
  }

  return isDark(background) ? "#f9fbff" : "#15141a";
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
