(function attachBiliWatchLaterDB(root) {
  "use strict";

  const core = root.BiliWLCore;
  const DB_NAME = "bili-watchlater-classifier";
  const DB_VERSION = 1;
  let dbPromise = null;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function txDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("videos")) {
          const store = db.createObjectStore("videos", { keyPath: "bvid" });
          store.createIndex("presentInWatchlater", "presentInWatchlater", { unique: false });
          store.createIndex("lastSeenAt", "lastSeenAt", { unique: false });
          store.createIndex("sourceHash", "sourceHash", { unique: false });
        }
        if (!db.objectStoreNames.contains("classifications")) {
          const store = db.createObjectStore("classifications", { keyPath: "bvid" });
          store.createIndex("manualOverride", "manualOverride", { unique: false });
          store.createIndex("classifiedAt", "classifiedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("jobs")) {
          const store = db.createObjectStore("jobs", { keyPath: "id" });
          store.createIndex("type", "type", { unique: false });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Cannot open IndexedDB"));
    });
    return dbPromise;
  }

  async function get(storeName, key) {
    const db = await openDB();
    const tx = db.transaction(storeName, "readonly");
    return requestToPromise(tx.objectStore(storeName).get(key));
  }

  async function getAll(storeName) {
    const db = await openDB();
    const tx = db.transaction(storeName, "readonly");
    return requestToPromise(tx.objectStore(storeName).getAll());
  }

  async function put(storeName, value) {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    await txDone(tx);
    return value;
  }

  async function putMany(storeName, values) {
    const items = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!items.length) return 0;
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    items.forEach((value) => store.put(value));
    await txDone(tx);
    return items.length;
  }

  async function remove(storeName, key) {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    await txDone(tx);
  }

  async function clear(storeName) {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    await txDone(tx);
  }

  async function upsertVideos(items, options) {
    const results = [];
    const errors = [];
    for (const item of items || []) {
      try {
        const bvid = core.normalizeBvid(item && (item.bvid || item.pageUrl));
        if (!bvid) continue;
        const existing = await get("videos", bvid);
        const merged = core.canonicalizeVideo(item, existing, options);
        await put("videos", merged);
        results.push({ video: merged, isNew: !existing, sourceChanged: existing && existing.sourceHash !== merged.sourceHash });
      } catch (error) {
        errors.push(error && error.message ? error.message : String(error));
      }
    }
    return { results, errors };
  }

  async function markRemovedExcept(presentBvids) {
    const present = new Set(presentBvids || []);
    const videos = await getAll("videos");
    const removed = [];
    for (const video of videos) {
      if (video.presentInWatchlater !== false && !present.has(video.bvid)) {
        video.presentInWatchlater = false;
        video.lastSeenAt = Date.now();
        await put("videos", video);
        removed.push(video.bvid);
      }
    }
    return removed;
  }

  async function markRemoved(bvid) {
    const normalized = core.normalizeBvid(bvid);
    if (!normalized) return null;
    const video = await get("videos", normalized);
    if (!video) return null;
    video.presentInWatchlater = false;
    video.lastSeenAt = Date.now();
    await put("videos", video);
    return video;
  }

  async function putClassification(classification) {
    return put("classifications", classification);
  }

  async function getClassification(bvid) {
    return get("classifications", bvid);
  }

  async function queueJobs(type, bvids, reason) {
    const now = Date.now();
    let queued = 0;
    for (const bvid of new Set(bvids || [])) {
      const normalized = core.normalizeBvid(bvid);
      if (!normalized) continue;
      const id = type + ":" + normalized;
      const existing = await get("jobs", id);
      if (existing && (existing.status === "pending" || existing.status === "running")) continue;
      await put("jobs", {
        id,
        type,
        bvid: normalized,
        reason: reason || "",
        status: "pending",
        attempts: existing && existing.attempts ? existing.attempts : 0,
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now
      });
      queued += 1;
    }
    return queued;
  }

  async function updateJob(id, patch) {
    const existing = await get("jobs", id);
    if (!existing) return null;
    const next = Object.assign({}, existing, patch || {}, { updatedAt: Date.now() });
    await put("jobs", next);
    return next;
  }

  async function pendingJobs(type) {
    const jobs = await getAll("jobs");
    return jobs
      .filter((job) => job.type === type && job.status === "pending")
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async function summary() {
    const videos = await getAll("videos");
    const classifications = await getAll("classifications");
    const jobs = await getAll("jobs");
    return { videos, classifications, jobs };
  }

  async function snapshot() {
    const summaryResult = await summary();
    return Object.assign(summaryResult, { meta: await getAll("meta") });
  }

  root.BiliWLDB = Object.freeze({
    DB_NAME,
    DB_VERSION,
    openDB,
    get,
    getAll,
    put,
    putMany,
    remove,
    clear,
    upsertVideos,
    markRemovedExcept,
    markRemoved,
    putClassification,
    getClassification,
    queueJobs,
    updateJob,
    pendingJobs,
    summary,
    snapshot
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
