// Retired preview worker invocations must not fall through to the main app,
// which opens operator data. Ordinary launches share one application entry.
if (
  Object.hasOwn(process.env, 'MOOR_PREVIEW_NONCE') ||
  Object.hasOwn(process.env, 'MOOR_PREVIEW_DATA')
) {
  process.stderr.write('Moor preview workers are retired\n');
  process.exit(1);
} else {
  require('./main/main.cjs');
}
