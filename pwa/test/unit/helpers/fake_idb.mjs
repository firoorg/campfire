// A small in-memory IndexedDB, enough for lib/store.js (one object store, out-of-line keys):
// open with an upgrade, readonly/readwrite transactions, get/put/delete/clear/getAllKeys with a
// bound key range. Values are copied in and out (structuredClone), as IndexedDB does.
export function fakeIndexedDB() {
  const dbs = new Map(); // name -> Map(storeName -> Map(key -> value))
  const later = (fn) => setImmediate(fn);
  function request(run) {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      try {
        r.result = run();
        if (r.onsuccess) r.onsuccess({ target: r });
      } catch (e) {
        r.error = e;
        if (r.onerror) r.onerror({ target: r });
      }
    });
    return r;
  }
  function database(stores) {
    return {
      objectStoreNames: { contains: (n) => stores.has(n) },
      createObjectStore(n) {
        stores.set(n, new Map());
      },
      close() {},
      transaction(name, mode) {
        const m = stores.get(name);
        let pending = 0;
        const t = { oncomplete: null, onerror: null, onabort: null, error: null };
        const done = () => later(() => pending === 0 && t.oncomplete && t.oncomplete());
        const op = (fn, write) => {
          if (write && mode !== 'readwrite') throw new Error('ReadOnlyError');
          pending++;
          const r = request(fn);
          // Settles after the request's success handler and what it chains (a request made from a
          // success handler keeps the transaction open, as in IndexedDB).
          setImmediate(() =>
            setImmediate(() => {
              pending--;
              done();
            }),
          );
          return r;
        };
        const inRange = (k, range) => !range || (k >= range.lower && k <= range.upper);
        t.objectStore = () => ({
          get: (k) => op(() => structuredClone(m.get(k))),
          put: (v, k) => op(() => (m.set(k, structuredClone(v)), k), true),
          delete: (k) => op(() => void m.delete(k), true),
          clear: () => op(() => void m.clear(), true),
          getAllKeys: (range) => op(() => [...m.keys()].filter((k) => inRange(k, range)).sort()),
        });
        later(done);
        return t;
      },
    };
  }
  return {
    dbs,
    open(name) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        r.result = database(dbs.get(name));
        if (fresh && r.onupgradeneeded) r.onupgradeneeded();
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    },
    /** name -> {key: value} of one object store, for asserting. */
    dump(name, store) {
      const s = dbs.get(name) && dbs.get(name).get(store);
      return s ? Object.fromEntries(s) : {};
    },
  };
}

export const IDBKeyRangeStub = { bound: (lower, upper) => ({ lower, upper }) };
