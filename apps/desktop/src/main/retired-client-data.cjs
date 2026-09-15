const fs = require('node:fs');
const path = require('node:path');

// These partitions belonged only to the retired HTTP client. The packaged
// client, host database, private credentials and settings use separate paths.
function removeRetiredClientData(data) {
  const directory = path.join(fs.realpathSync(data), 'Partitions');
  let parent;
  try {
    parent = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw Error('旧客户端缓存目录不是独立目录，无法清理。');
  for (const name of ['personal-local', 'personal-remote']) {
    const retired = path.join(directory, name);
    // rm removes links themselves; it never follows them to another data root.
    fs.rmSync(retired, { recursive: true, force: true });
  }
}

module.exports = { removeRetiredClientData };
