const fs = require('node:fs');
const modes = new Set(['dark', 'light', 'system']);

// Client-only preference: never enters a project, session, or relay document.
function createAppearance({ file, nativeTheme, write, changed }) {
  let current = 'system';
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (modes.has(saved)) current = saved;
  } catch {}
  nativeTheme.themeSource = current;
  return {
    read: () => current,
    set(value) {
      if (!modes.has(value)) throw new TypeError('外观必须为 Dark mode、Light mode 或 Auto。');
      write(file, value);
      current = value;
      nativeTheme.themeSource = value;
      changed(value);
      return current;
    },
  };
}
module.exports = { createAppearance };
