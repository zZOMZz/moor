const { ipcRenderer } = require('electron');

// No API is exposed to the old origin. This isolated reader opens only Moor's
// existing database and uses readonly key scans plus explicit reads of selected records.
ipcRenderer.once('moor:legacy-cache-read', async (_event, input) => {
  const finish = (value) =>
    ipcRenderer.send('moor:legacy-cache-result', { nonce: input.nonce, ...value });
  let database;
  try {
    if (
      location.href !== input.url ||
      !Array.isArray(input.prefixes) ||
      input.prefixes.length > 32 ||
      input.prefixes.some((prefix) => typeof prefix !== 'string' || prefix.length > 4096)
    )
      throw Error('Invalid reader target');
    if (typeof indexedDB.databases !== 'function') throw Error('Database discovery unavailable');
    if (!(await indexedDB.databases()).some((entry) => entry.name === 'moor-runtime-v1')) {
      finish(input.keysOnly ? { ok: true, keys: [] } : { ok: true, records: [] });
      return;
    }
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('moor-runtime-v1');
      request.onupgradeneeded = () => {
        request.transaction.abort();
        reject(Error('Unsupported database'));
      };
      request.onerror = () => reject(Error('Database unavailable'));
      request.onblocked = () => reject(Error('Database blocked'));
      request.onsuccess = () => resolve(request.result);
    });
    if (database.version !== 1 || !database.objectStoreNames.contains('cache'))
      throw Error('Unsupported database');
    const records = await new Promise((resolve, reject) => {
      const tx = database.transaction('cache', 'readonly'),
        store = tx.objectStore('cache'),
        records = [];
      let bytes = 0;
      const prefixes = [...input.prefixes];
      const sessionId = (value) =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
      const collect = (value, limit, count) => {
        bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (records.length >= count || bytes > limit)
          throw Error('Cache exceeds selected read limit');
        records.push(value);
      };
      const scan = () => {
        const request = store.openKeyCursor();
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) return;
            if (
              typeof cursor.key !== 'string' ||
              !prefixes.some((prefix) => cursor.key.startsWith(prefix))
            ) {
              cursor.continue();
              return;
            }
            if (input.keysOnly) {
              collect(cursor.key, 32 * 1024 * 1024, 100000);
              cursor.continue();
              return;
            }
            const reading = store.get(cursor.key);
            reading.onsuccess = () => {
              try {
                if (reading.result !== undefined)
                  collect(
                    { key: cursor.key, value: reading.result },
                    ((input.scoped ? 256 : 96) - 1) * 1024 * 1024,
                    10000,
                  );
                cursor.continue();
              } catch {
                tx.abort();
              }
            };
          } catch {
            tx.abort();
          }
        };
      };
      tx.oncomplete = () => resolve(records);
      tx.onerror = tx.onabort = () => reject(Error('Cache read failed'));
      if (!input.newDraft) {
        scan();
        return;
      }
      const hints = input.newDraft;
      if (
        input.keysOnly ||
        !Array.isArray(hints.sessionPrefixes) ||
        hints.sessionPrefixes.length > 32 ||
        [...hints.sessionPrefixes, hints.reservationKey, hints.pendingKey, hints.actionPrefix].some(
          (key) => typeof key !== 'string' || key.length > 4096,
        )
      ) {
        tx.abort();
        return;
      }
      let remaining = 2;
      const ids = new Set();
      for (const key of [hints.reservationKey, hints.pendingKey]) {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const value = request.result;
            const id =
              key === hints.reservationKey
                ? value
                : (value?.mutation?.sessionId ?? value?.sessionId);
            if (sessionId(id)) ids.add(id);
            if (--remaining) return;
            for (const id of ids) {
              prefixes.push(...hints.sessionPrefixes.map((prefix) => prefix + JSON.stringify(id)));
              prefixes.push(hints.actionPrefix + id + '/session-action');
            }
            scan();
          } catch {
            tx.abort();
          }
        };
      }
    });
    finish(input.keysOnly ? { ok: true, keys: records } : { ok: true, records });
  } catch {
    finish({ ok: false });
  } finally {
    database?.close();
  }
});
