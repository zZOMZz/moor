// Packaged Electron loads package.main even when a worker path is supplied in argv.
// Select the private worker before importing anything that can open Moor user data.
const privatePreview =
  Object.hasOwn(process.env, 'MOOR_PREVIEW_NONCE') ||
  Object.hasOwn(process.env, 'MOOR_PREVIEW_DATA');

if (!privatePreview) {
  require('./main.cjs');
} else {
  let valid = false;
  try {
    const { lstatSync } = require('node:fs');
    const { isAbsolute, resolve } = require('node:path');
    const nonce = process.env.MOOR_PREVIEW_NONCE;
    const directory = process.env.MOOR_PREVIEW_DATA;
    if (
      typeof nonce === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce) &&
      typeof directory === 'string' &&
      isAbsolute(directory)
    ) {
      // Permit canonical parent aliases such as macOS /var, but never a symlink
      // at the private directory itself or a directory readable by other users.
      const stat = lstatSync(resolve(directory));
      valid =
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        (typeof process.getuid !== 'function' || stat.uid === process.getuid());
    }
  } catch {}
  if (!valid) {
    process.stderr.write('Invalid private preview process configuration\n');
    process.exit(1);
  } else {
    try {
      require('./runtime/preview-renderer.cjs');
    } catch {
      process.stderr.write('Private preview process failed to start\n');
      process.exit(1);
    }
  }
}
