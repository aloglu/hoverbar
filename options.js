const checkbox = document.getElementById("show-names");
const folderCheckbox = document.getElementById("show-folder-names");
const status = document.getElementById("status");

init().catch((error) => {
  console.error("Hoverbar options failed to load", error);
  status.textContent = "Settings could not be loaded.";
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

async function init() {
  const [{ showNames = false, showFolderNames = true }] = await Promise.all([
    browser.storage.local.get({
      showNames: false,
      showFolderNames: true
    }),
    applyTheme()
  ]);

  checkbox.checked = showNames;
  folderCheckbox.checked = showFolderNames;
}

async function save() {
  await browser.storage.local.set({
    showNames: checkbox.checked,
    showFolderNames: folderCheckbox.checked
  });

  status.textContent = "Saved.";
  window.clearTimeout(window.__hoverbarStatusTimer);
  window.__hoverbarStatusTimer = window.setTimeout(() => {
    status.textContent = "";
  }, 1200);
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

  const colors = theme?.colors ?? {};
  const root = document.documentElement;
  const background = firstColor(colors.popup, colors.toolbar, colors.frame);
  const foreground = firstColor(colors.popup_text, colors.toolbar_text, colors.tab_text) || readableText(background);
  const panel = firstColor(colors.toolbar_field, colors.popup, colors.toolbar, colors.frame);
  const accent = firstColor(colors.icons_attention, colors.button_background_active, colors.toolbar_text, colors.popup_text);
  const border = firstColor(colors.popup_border, colors.toolbar_field_border, foreground ? withAlpha(foreground, 0.16) : null);
  const mode = theme?.properties?.color_scheme || theme?.properties?.content_color_scheme || (background ? (isDark(background) ? "dark" : "light") : null);

  setVar("--page-bg", background);
  setVar("--text", foreground);
  setVar("--panel", panel);
  setVar("--panel-border", border);
  setVar("--divider", foreground ? withAlpha(foreground, 0.12) : null);
  setVar("--muted", foreground ? withAlpha(foreground, 0.72) : null);
  setVar("--soft", foreground ? withAlpha(foreground, 0.64) : null);
  setVar("--eyebrow", foreground ? withAlpha(foreground, 0.72) : null);
  setVar("--switch-track", foreground ? withAlpha(foreground, 0.28) : null);
  setVar("--switch-track-on", accent);
  setVar("--switch-thumb", background || panel);
  setVar("--switch-focus", accent ? withAlpha(accent, 0.28) : null);
  setVar("--status", accent);

  if (mode) {
    root.style.colorScheme = mode;
  } else {
    root.style.removeProperty("color-scheme");
  }

  function setVar(name, value) {
    if (value) {
      root.style.setProperty(name, value);
    } else {
      root.style.removeProperty(name);
    }
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
