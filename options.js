const checkbox = document.getElementById("show-names");
const folderCheckbox = document.getElementById("show-folder-names");
const folderColorSwatch = document.getElementById("folder-color-swatch");
const folderColorText = document.getElementById("folder-color-text");
const folderIconMode = document.getElementById("folder-icon-mode");

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

folderColorText.addEventListener("input", async () => {
  const normalized = normalizeColor(folderColorText.value);
  if (!normalized) {
    return;
  }

  folderColorText.value = normalized;
  updateFolderColorSwatch(normalized);
  await save();
});

folderIconMode.addEventListener("change", async () => {
  await save();
});

async function init() {
  const [{ showNames = false, showFolderNames = true, folderColor: savedFolderColor = "", folderIconMode: savedFolderIconMode = "emoji" }] = await Promise.all([
    browser.storage.local.get({
      showNames: false,
      showFolderNames: true,
      folderColor: "",
      folderIconMode: "emoji"
    }),
    applyTheme()
  ]);

  checkbox.checked = showNames;
  folderCheckbox.checked = showFolderNames;
  folderColorText.value = normalizeColor(savedFolderColor) || "#d0a21b";
  updateFolderColorSwatch(folderColorText.value);
  folderIconMode.value = normalizeFolderIconMode(savedFolderIconMode);
}

async function save() {
  const normalizedFolderColor = normalizeColor(folderColorText.value) || "#d0a21b";

  await browser.storage.local.set({
    showNames: checkbox.checked,
    showFolderNames: folderCheckbox.checked,
    folderColor: normalizedFolderColor,
    folderIconMode: normalizeFolderIconMode(folderIconMode.value)
  });
}

function normalizeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "";
}

function updateFolderColorSwatch(value) {
  folderColorSwatch.style.backgroundColor = normalizeColor(value) || "#d0a21b";
}

function normalizeFolderIconMode(value) {
  return ["emoji", "folder", "both"].includes(value) ? value : "emoji";
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
