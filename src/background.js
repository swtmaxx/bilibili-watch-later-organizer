importScripts("shared.js", "idb.js");

const core = globalThis.BiliWLCore;
const db = globalThis.BiliWLDB;
const CLASSIFICATION_REPAIR_VERSION = "0.2.4";
const ONBOARDING_VERSION = 1;
const AUTO_LLM_ALARM = "auto-llm-classify";
const AUTO_LLM_CONTINUE_ALARM = "auto-llm-classify-continue";
const AUTO_LLM_REFRESH_TRIGGER = "refresh";
const AUTO_LLM_MAX_BATCHES_PER_WAKE = 2;
const MAX_BACKUP_RECORDS = 100000;
const FAVORITE_TITLE_MAX_LENGTH = 50;
const BACKUP_VIDEO_METADATA_FIELDS = Object.freeze([
  "oid",
  "aid",
  "title",
  "pageUrl",
  "upName",
  "upMid",
  "coverUrl",
  "tname",
  "tags",
  "desc",
  "duration",
  "viewCount",
  "danmakuCount",
  "likeCount",
  "coinCount",
  "favoriteCount",
  "shareCount",
  "replyCount",
  "watchProgress",
  "isWatched",
  "pubdate",
  "watchlaterAddedAt",
  "watchlaterOrder",
  "pageParts"
]);

let detailRunPromise = null;
let classificationRepairPromise = null;
let initializationPromise = null;
let autoLlmRunPromise = null;
let progress = {
  status: "idle",
  message: "等待扫描",
  pending: 0,
  running: 0,
  done: 0,
  failed: 0,
  updatedAt: Date.now()
};

chrome.runtime.onInstalled.addListener((details) => {
  initializationPromise = initializeExtension(details)
    .catch((error) => console.warn("init failed", error))
    .finally(() => {
      initializationPromise = null;
    });
});

chrome.runtime.onStartup.addListener(() => {
  initializationPromise = initializeExtension({})
    .catch((error) => console.warn("startup init failed", error))
    .finally(() => {
      initializationPromise = null;
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || ![AUTO_LLM_ALARM, AUTO_LLM_CONTINUE_ALARM].includes(alarm.name)) return;
  maybeRunAutoLlmClassification(alarm.name)
    .catch((error) => console.warn("automatic AI classification failed", error));
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message || {}, sender)
    .then((response) => sendResponse({ ok: true, data: response }))
    .catch((error) => sendResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    }));
  return true;
});

async function handleMessage(message) {
  if (initializationPromise) await initializationPromise;
  await ensureConfig();
  await ensureClassificationRepair();
  switch (message.type) {
    case core.MESSAGE_TYPES.GET_STATE:
      return getState();
    case core.MESSAGE_TYPES.EXPORT_DATA:
      return exportDataBackup();
    case core.MESSAGE_TYPES.IMPORT_DATA:
      return importDataBackup(message.payload);
    case core.MESSAGE_TYPES.SCAN_WATCHLATER:
      return scanWatchlater(message);
    case core.MESSAGE_TYPES.UPSERT_VIDEO_ITEMS:
      return upsertVideoItems(message.items || [], { markRemoved: false });
    case core.MESSAGE_TYPES.FETCH_VIDEO_DETAILS:
      return queueMissingVideoDetails();
    case core.MESSAGE_TYPES.EXPORT_CATEGORY_PROPOSAL:
      return exportCategoryProposal(message);
    case core.MESSAGE_TYPES.IMPORT_CATEGORIES:
      return importCategories(message);
    case core.MESSAGE_TYPES.EXPORT_AI_CLASSIFY_BATCH:
      return exportClassifyBatch(message);
    case core.MESSAGE_TYPES.IMPORT_AI_CLASSIFICATIONS:
      return importClassifications(message.payload, message.options || {});
    case core.MESSAGE_TYPES.AUTO_CLASSIFY:
      return autoClassify(message.options || {});
    case core.MESSAGE_TYPES.CHECK_BILI_LOGIN:
      return checkBiliLogin();
    case core.MESSAGE_TYPES.SYNC_ON_OPEN:
      return syncOnOpen(message);
    case core.MESSAGE_TYPES.CHECK_AUTO_LLM:
      return checkAutoLlmClassification(AUTO_LLM_REFRESH_TRIGGER);
    case core.MESSAGE_TYPES.SAVE_MANUAL_CLASSIFICATION:
      return saveManualClassification(message);
    case core.MESSAGE_TYPES.BULK_UPDATE_CLASSIFICATIONS:
      return bulkUpdateClassifications(message);
    case core.MESSAGE_TYPES.CREATE_FAVORITE_FOLDER_AND_ADD:
      return createFavoriteFolderAndAdd(message);
    case core.MESSAGE_TYPES.REMOVE_FROM_WATCHLATER:
      return removeFromWatchlater(message);
    case core.MESSAGE_TYPES.BULK_REMOVE_FROM_WATCHLATER:
      return bulkRemoveFromWatchlater(message);
    case core.MESSAGE_TYPES.UPDATE_SETTINGS:
      return updateSettings(message.settings || {});
    case core.MESSAGE_TYPES.OPEN_DASHBOARD:
      await openDashboard();
      return getState();
    case core.MESSAGE_TYPES.ADD_CATEGORY:
      return addCategory(message);
    case core.MESSAGE_TYPES.UPDATE_CATEGORY:
      return updateCategory(message);
    case core.MESSAGE_TYPES.DELETE_CATEGORY:
      return deleteCategory(message);
    case core.MESSAGE_TYPES.SAVE_CATEGORIES:
      return saveCategories(message);
    case core.MESSAGE_TYPES.REORDER_CATEGORY:
      return reorderCategory(message);
    default:
      throw new Error("Unknown message type: " + message.type);
  }
}

async function initializeExtension(details) {
  await ensureConfig();
  await initializeOnboarding(details || {});
  await ensureClassificationRepair();
  const config = await getConfig();
  await configureAutoLlmAlarm(config.settings, false);
}

async function initializeOnboarding(details) {
  if (!details || !["install", "update"].includes(details.reason)) return;
  const data = await chromeStorageGet(["settings"]);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings || {});
  if (details.reason === "install") {
    Object.assign(settings, {
      onboardingVersion: ONBOARDING_VERSION,
      onboardingEligible: true,
      onboardingCompleted: false,
      onboardingStage: "login",
      onboardingMethod: ""
    });
  } else if (!Object.prototype.hasOwnProperty.call(data.settings || {}, "onboardingVersion")) {
    Object.assign(settings, {
      onboardingVersion: ONBOARDING_VERSION,
      onboardingEligible: false,
      onboardingCompleted: true,
      onboardingStage: "complete",
      onboardingMethod: ""
    });
  } else {
    return;
  }
  await chromeStorageSet({ settings });
}

function chromeStorageGet(keys) {
  return chrome.storage.local.get(keys);
}

function chromeStorageSet(values) {
  return chrome.storage.local.set(values);
}

function migrateOnboardingSettings(settings) {
  if (!settings || typeof settings !== "object") return;
  if (settings.onboardingStage === "setup-prompt") settings.onboardingStage = "setup-api";
  if (settings.onboardingMethod === "prompt") settings.onboardingMethod = "api";
}

async function ensureConfig() {
  const data = await chromeStorageGet(["settings", "categories"]);
  const updates = {};
  if (!data.settings) {
    updates.settings = Object.assign({}, core.DEFAULT_SETTINGS);
  } else {
    updates.settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings);
  }
  updates.settings.browseMode = core.normalizeBrowseMode(updates.settings.browseMode);
  updates.settings.videoViewMode = core.normalizeVideoViewMode(updates.settings.videoViewMode);
  updates.settings.collapsedCategoryIds = core.normalizeCollapsedCategoryIds(updates.settings.collapsedCategoryIds);
  migrateOnboardingSettings(updates.settings);
  updates.settings.categorySampleLimit = core.normalizeCategorySampleLimit(
    updates.settings.categorySampleLimit,
    core.DEFAULT_SETTINGS.categorySampleLimit
  );
  if (!Array.isArray(data.categories) || !data.categories.length) {
    updates.categories = core.DEFAULT_CATEGORIES.map((category) => Object.assign({}, category));
  }
  if (Object.keys(updates).length) {
    await chromeStorageSet(updates);
  }
}

async function getConfig() {
  await ensureConfig();
  const data = await chromeStorageGet(["settings", "categories"]);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings || {});
  settings.browseMode = core.normalizeBrowseMode(settings.browseMode);
  settings.videoViewMode = core.normalizeVideoViewMode(settings.videoViewMode);
  settings.collapsedCategoryIds = core.normalizeCollapsedCategoryIds(settings.collapsedCategoryIds);
  settings.categorySampleLimit = core.normalizeCategorySampleLimit(
    settings.categorySampleLimit,
    core.DEFAULT_SETTINGS.categorySampleLimit
  );
  return {
    settings,
    categories: Array.isArray(data.categories) && data.categories.length
      ? data.categories
      : core.DEFAULT_CATEGORIES.map((category) => Object.assign({}, category))
  };
}

async function ensureClassificationRepair() {
  const data = await chromeStorageGet(["settings"]);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings || {});
  if (settings.classificationRepairVersion === CLASSIFICATION_REPAIR_VERSION) return;
  if (!classificationRepairPromise) {
    classificationRepairPromise = runClassificationRepair()
      .catch((error) => {
        setProgress({ status: "error", message: "分类修复失败：" + (error && error.message ? error.message : String(error)), running: 0 });
        throw error;
      })
      .finally(() => {
        classificationRepairPromise = null;
      });
  }
  return classificationRepairPromise;
}

async function runClassificationRepair() {
  setProgress({ status: "running", message: "正在迁移分类来源标记", running: 1, pending: 0, done: 0, failed: 0 });
  let migrated = 0;
  const classifications = await db.getAll("classifications");
  for (const classification of classifications) {
    const sourceType = core.classificationSourceType(classification);
    const manualOverride = sourceType === core.CLASSIFICATION_SOURCE_TYPES.MANUAL;
    if (classification.sourceType !== sourceType || Boolean(classification.manualOverride) !== manualOverride) {
      await db.putClassification(Object.assign({}, classification, { sourceType, manualOverride }));
      migrated += 1;
    }
  }
  const data = await chromeStorageGet(["settings"]);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings || {}, {
    classificationRepairVersion: CLASSIFICATION_REPAIR_VERSION
  });
  await chromeStorageSet({ settings });
  setProgress({
    status: "idle",
    message: "分类来源迁移完成：更新 " + migrated + " 项",
    running: 0,
    updatedAt: Date.now()
  });
}

async function updateSettings(nextSettings) {
  const config = await getConfig();
  const settings = Object.assign({}, config.settings);
  if ([core.BROWSE_MODES.CATEGORIES, core.BROWSE_MODES.UP].includes(nextSettings.browseMode)) {
    settings.browseMode = nextSettings.browseMode;
  }
  if ([core.VIDEO_VIEW_MODES.CARDS, core.VIDEO_VIEW_MODES.LIST].includes(nextSettings.videoViewMode)) {
    settings.videoViewMode = nextSettings.videoViewMode;
  }
  if (Array.isArray(nextSettings.collapsedCategoryIds)) {
    settings.collapsedCategoryIds = core.normalizeCollapsedCategoryIds(nextSettings.collapsedCategoryIds);
  }
  if (["watchlater", "pubdate", "duration"].includes(nextSettings.sortMode)) {
    settings.sortMode = nextSettings.sortMode;
  }
  if (["asc", "desc"].includes(nextSettings.sortDirection)) {
    settings.sortDirection = nextSettings.sortDirection;
  }
  if (Number.isFinite(Number(nextSettings.batchSize))) {
    settings.batchSize = Math.min(100, Math.max(20, Number(nextSettings.batchSize)));
  }
  if (Number.isFinite(Number(nextSettings.detailConcurrency))) {
    settings.detailConcurrency = Math.min(6, Math.max(1, Number(nextSettings.detailConcurrency)));
  }
  if (Number.isFinite(Number(nextSettings.llmBatchSize))) {
    settings.llmBatchSize = Math.min(100, Math.max(1, Number(nextSettings.llmBatchSize)));
  }
  if (Number.isFinite(Number(nextSettings.llmLimit))) {
    settings.llmLimit = Math.min(10000, Math.max(0, Number(nextSettings.llmLimit)));
  }
  if (Number.isFinite(Number(nextSettings.categorySampleLimit))) {
    settings.categorySampleLimit = core.normalizeCategorySampleLimit(
      nextSettings.categorySampleLimit,
      settings.categorySampleLimit
    );
  }
  if (Number.isFinite(Number(nextSettings.llmTemperature))) {
    settings.llmTemperature = Math.min(2, Math.max(0, Number(nextSettings.llmTemperature)));
  }
  if (["off", "daily", "weekly", "threshold"].includes(nextSettings.llmAutoClassifyMode)) {
    settings.llmAutoClassifyMode = nextSettings.llmAutoClassifyMode;
  }
  if (Number.isFinite(Number(nextSettings.llmAutoClassifyThreshold))) {
    settings.llmAutoClassifyThreshold = Math.min(10000, Math.max(1, Math.floor(Number(nextSettings.llmAutoClassifyThreshold))));
  }
  if (typeof nextSettings.detailFetchEnabled === "boolean") {
    settings.detailFetchEnabled = nextSettings.detailFetchEnabled;
  }
  if (typeof nextSettings.llmIncludeAll === "boolean") {
    settings.llmIncludeAll = nextSettings.llmIncludeAll;
  }
  if (typeof nextSettings.llmUseResponseFormat === "boolean") {
    settings.llmUseResponseFormat = nextSettings.llmUseResponseFormat;
  }
  if (typeof nextSettings.llmApiFormat === "string") {
    settings.llmApiFormat = core.normalizeLlmApiFormat(nextSettings.llmApiFormat);
  }
  if (typeof nextSettings.onboardingEligible === "boolean") {
    settings.onboardingEligible = nextSettings.onboardingEligible;
  }
  if (typeof nextSettings.onboardingCompleted === "boolean") {
    settings.onboardingCompleted = nextSettings.onboardingCompleted;
  }
  if (["login", "setup", "setup-categories", "setup-api", "setup-result", "guide", "classify", "complete"].includes(nextSettings.onboardingStage)) {
    settings.onboardingStage = nextSettings.onboardingStage;
  }
  if (["", "categories", "api"].includes(nextSettings.onboardingMethod)) {
    settings.onboardingMethod = nextSettings.onboardingMethod;
  }
  if (Number.isFinite(Number(nextSettings.onboardingVersion))) {
    settings.onboardingVersion = Number(nextSettings.onboardingVersion);
  }
  ["llmBaseUrl", "llmModel", "llmApiKey"].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(nextSettings, key)) {
      settings[key] = core.normalizeText(nextSettings[key]);
    }
  });
  await chromeStorageSet({ settings });
  if (Object.prototype.hasOwnProperty.call(nextSettings, "llmAutoClassifyMode") || Object.prototype.hasOwnProperty.call(nextSettings, "llmAutoClassifyThreshold")) {
    await configureAutoLlmAlarm(settings, true);
  }
  return getState();
}

async function configureAutoLlmAlarm(settings, force) {
  const mode = settings && settings.llmAutoClassifyMode;
  const existing = await chrome.alarms.get(AUTO_LLM_ALARM);
  if (!force && existing && mode !== "off") return;
  await chrome.alarms.clear(AUTO_LLM_ALARM);
  await chrome.alarms.clear(AUTO_LLM_CONTINUE_ALARM);
  if (mode === "daily") {
    chrome.alarms.create(AUTO_LLM_ALARM, { delayInMinutes: 24 * 60, periodInMinutes: 24 * 60 });
  } else if (mode === "weekly") {
    chrome.alarms.create(AUTO_LLM_ALARM, { delayInMinutes: 7 * 24 * 60, periodInMinutes: 7 * 24 * 60 });
  } else if (mode === "threshold") {
    chrome.alarms.create(AUTO_LLM_ALARM, { delayInMinutes: 1, periodInMinutes: 30 });
  }
}

async function maybeRunAutoLlmClassification(triggerName) {
  if (autoLlmRunPromise) return autoLlmRunPromise;
  autoLlmRunPromise = runScheduledLlmClassification(triggerName)
    .finally(() => {
      autoLlmRunPromise = null;
    });
  return autoLlmRunPromise;
}

async function checkAutoLlmClassification(triggerName) {
  const result = await maybeRunAutoLlmClassification(triggerName);
  return Object.assign(await getState(), { autoLlmResult: result });
}

async function runScheduledLlmClassification(triggerName) {
  const config = await getConfig();
  const settings = config.settings || {};
  const mode = settings.llmAutoClassifyMode || "off";
  if (mode === "off") return { skipped: true, reason: "disabled" };
  if (triggerName === AUTO_LLM_REFRESH_TRIGGER && mode !== "threshold") {
    return { skipped: true, reason: "refresh-check-only-threshold" };
  }
  if (!apiConfigReady(settings)) {
    await writeAutoLlmStatus({
      llmAutoClassifyLastRunAt: Date.now(),
      llmAutoClassifyLastStatus: "自动分类未运行：请先完成并测试 API 设置",
      llmAutoClassifyLastImported: 0
    });
    return { skipped: true, reason: "api-not-configured" };
  }

  const summary = await db.summary();
  const counts = core.classificationStageCounts(summary.videos, summary.classifications);
  const threshold = Math.max(1, Number(settings.llmAutoClassifyThreshold) || 50);
  if (triggerName !== AUTO_LLM_CONTINUE_ALARM && mode === "threshold" && counts.pending < threshold) {
    await writeAutoLlmStatus({
      llmAutoClassifyLastStatus: "等待待精细分类达到 " + threshold + " 个；当前 " + counts.pending + " 个"
    });
    return { skipped: true, reason: "below-threshold", pending: counts.pending };
  }
  if (!counts.pending) {
    await writeAutoLlmStatus({ llmAutoClassifyLastStatus: "没有待精细分类的视频" });
    return { skipped: true, reason: "no-pending" };
  }

  const startedAt = Date.now();
  setProgress({ status: "running", message: "正在自动进行 API 视频分类", running: 1, pending: counts.pending, done: 0, failed: 0 });
  try {
    const result = await runAutomaticLlmBatches(settings);
    await writeAutoLlmStatus({
      llmAutoClassifyLastRunAt: startedAt,
      llmAutoClassifyLastStatus: "自动分类完成：导入 " + result.imported + " 项，跳过 " + result.skipped + " 项" + (result.remaining ? "；剩余任务稍后继续" : ""),
      llmAutoClassifyLastImported: result.imported
    });
    setProgress({ status: "idle", message: "自动 API 视频分类完成：导入 " + result.imported + " 项", running: 0, pending: result.remaining, done: result.imported, failed: 0 });
    return result;
  } catch (error) {
    const errorMessage = error && error.message ? error.message : String(error);
    await writeAutoLlmStatus({
      llmAutoClassifyLastRunAt: startedAt,
      llmAutoClassifyLastStatus: "自动分类失败：" + errorMessage,
      llmAutoClassifyLastImported: 0
    });
    setProgress({ status: "error", message: "自动 API 视频分类失败：" + errorMessage, running: 0, failed: 1 });
    throw error;
  }
}

async function runAutomaticLlmBatches(settings) {
  const batchSize = Math.min(100, Math.max(1, Number(settings.llmBatchSize) || 50));
  let imported = 0;
  let skipped = 0;
  let batches = 0;
  let remaining = 0;
  while (batches < AUTO_LLM_MAX_BATCHES_PER_WAKE) {
    const exported = await exportClassifyBatch({ includeAll: false, limit: batchSize, offset: 0 });
    remaining = exported.totalCandidates || 0;
    if (!exported.batchSize) break;
    setProgress({ message: "正在自动分类第 " + (batches + 1) + " 批，共 " + exported.batchSize + " 个视频", pending: remaining, running: 1 });
    const payload = await callAutomaticLlm(settings, exported.prompt || "");
    const importedState = await importClassifications(JSON.stringify(payload), {
      mergeMode: "replace",
      batchBvids: exported.batchBvids
    });
    const importResult = importedState.importResult || {};
    imported += importResult.imported || 0;
    skipped += importResult.skipped || 0;
    batches += 1;
    if (!(importResult.imported || 0)) break;
  }
  const latest = await db.summary();
  remaining = core.classificationStageCounts(latest.videos, latest.classifications).pending;
  if (remaining > 0 && batches >= AUTO_LLM_MAX_BATCHES_PER_WAKE) {
    chrome.alarms.create(AUTO_LLM_CONTINUE_ALARM, { delayInMinutes: 1 });
  }
  return { imported, skipped, batches, remaining };
}

async function callAutomaticLlm(config, prompt) {
  const requestPrompt = [
    prompt,
    "",
    "重要：必须为本批待分类视频中的每一个 bvid 返回一项。不要漏掉视频；信息不足时用 other.todo。",
    "返回必须是严格 JSON 对象：所有属性名和字符串都必须使用双引号，顶层必须是 {\"items\":[...]}。"
  ].join("\n");
  let response = await sendAutomaticLlmRequest(config, requestPrompt, config.llmUseResponseFormat === true);
  let textValue = await response.text();
  if (!response.ok && config.llmUseResponseFormat === true && /response[_ ]format|text\.format|json_object/i.test(textValue)) {
    response = await sendAutomaticLlmRequest(config, requestPrompt, false);
    textValue = await response.text();
  }
  if (!response.ok) throw new Error("AI API HTTP " + response.status + ": " + textValue.slice(0, 300));
  const data = parseAutomaticJson(textValue);
  const content = core.extractLlmText(data);
  if (!content) throw new Error("AI 响应缺少可读取的文本内容");
  const parsed = parseAutomaticJson(content);
  const items = Array.isArray(parsed && parsed.items)
    ? parsed.items
    : Array.isArray(parsed && parsed.classifications)
      ? parsed.classifications
      : [];
  if (!items.length) throw new Error("AI 返回的 JSON 没有 items/classifications 数组");
  return { items };
}

function sendAutomaticLlmRequest(config, requestPrompt, useResponseFormat) {
  const body = core.buildLlmRequestBody(config, requestPrompt, useResponseFormat);
  return fetchWithTimeout(core.llmApiUrl(config.llmBaseUrl, config.llmApiFormat), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + config.llmApiKey,
      "x-title": "Bili Watchlater Classifier"
    },
    body: JSON.stringify(body)
  }, 120000);
}

function parseAutomaticJson(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("JSON 内容为空");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = fenced ? fenced[1].trim() : raw;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const repaired = candidate
      .replace(/^\uFEFF/, "")
      .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, "$1\"$2\"$3")
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, content) => JSON.stringify(content.replace(/\\"/g, "\"")))
      .replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch (repairError) {
      throw new Error("AI 返回的内容不是严格 JSON：" + repairError.message);
    }
  }
}

function apiConfigReady(settings) {
  return Boolean(core.normalizeText(settings && settings.llmBaseUrl) && core.normalizeText(settings && settings.llmModel) && core.normalizeText(settings && settings.llmApiKey));
}

async function writeAutoLlmStatus(patch) {
  const data = await chromeStorageGet(["settings"]);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings || {}, patch || {});
  await chromeStorageSet({ settings });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function chatCompletionsUrl(value) {
  return core.llmApiUrl(value, core.LLM_API_FORMATS.CHAT_COMPLETIONS);
}

async function openDashboard() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}

async function checkBiliLogin() {
  const cookie = await chrome.cookies.get({
    url: "https://www.bilibili.com/",
    name: "SESSDATA"
  });
  return {
    loginStatus: cookie && cookie.value ? "logged_in" : "logged_out"
  };
}

async function syncOnOpen(message) {
  const scanState = await scanWatchlater({ skipAutoClassify: Boolean(message && message.skipAutoClassify) });
  const scanResult = scanState.scanResult || {};
  const autoResult = scanState.autoClassifyResult || {};
  setProgress({
    status: "idle",
    message: "打开时同步完成：扫描 " + (scanResult.scannedCount || 0) + " 个" + (autoResult.skipped ? "，首次引导暂不分类视频" : "，完成初步分类 " + (autoResult.classified || 0) + " 个"),
    running: 0,
    pending: 0,
    updatedAt: Date.now()
  });
  return Object.assign(await getState(), {
    openSyncResult: {
      scanResult,
      autoClassifyResult: autoResult,
      apiError: scanState.apiError || "",
      apiCode: scanState.apiCode == null ? null : scanState.apiCode,
      loginStatus: scanState.loginStatus || "unknown"
    }
  });
}

async function getState() {
  const config = await getConfig();
  const summary = await db.summary();
  return Object.assign({}, summary, config, {
    progress,
    classifySummary: getClassifySummary(summary.videos, summary.classifications)
  });
}

async function exportDataBackup() {
  const config = await getConfig();
  const snapshot = await db.snapshot();
  return {
    format: core.DATA_BACKUP_FORMAT,
    version: core.DATA_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion: core.EXTENSION_VERSION,
    settings: config.settings,
    categories: config.categories,
    videos: snapshot.videos,
    classifications: snapshot.classifications,
    jobs: snapshot.jobs,
    meta: snapshot.meta
  };
}

function normalizeDataBackup(payload) {
  let parsed = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error("数据备份 JSON 无法解析：" + error.message);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("数据备份必须是 JSON 对象");
  }
  if (parsed.format !== core.DATA_BACKUP_FORMAT) {
    throw new Error("不是稍后再看整理助手的数据备份文件");
  }
  if (Number(parsed.version) !== core.DATA_BACKUP_VERSION) {
    throw new Error("不支持的数据备份版本：" + (parsed.version == null ? "未知" : parsed.version));
  }
  if (!Array.isArray(parsed.categories) || !parsed.categories.length) {
    throw new Error("数据备份中缺少分类目录");
  }

  const normalizedSettings = normalizeBackupSettings(parsed.settings);
  if (!parsed.settings || !Object.prototype.hasOwnProperty.call(parsed.settings, "collapsedCategoryIds")) {
    normalizedSettings.collapsedCategoryIds = [];
  }

  return {
    settings: normalizedSettings,
    categories: normalizeImportedCategories({ categories: parsed.categories }, { allowSmall: true, ensureFallback: true }),
    videos: normalizeBackupArray(parsed.videos, "videos"),
    classifications: normalizeBackupArray(parsed.classifications, "classifications"),
    jobs: normalizeBackupArray(parsed.jobs, "jobs"),
    meta: normalizeBackupArray(parsed.meta, "meta")
  };
}

function normalizeBackupSettings(settings) {
  if (settings == null) return {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("数据备份中的设置格式不正确");
  }
  const normalized = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(settings, key);
  const copyString = (key, maxLength) => {
    if (has(key)) normalized[key] = core.truncateText(settings[key], maxLength);
  };
  const copyNumber = (key, minimum, maximum, integer) => {
    if (!has(key)) return;
    const value = Number(settings[key]);
    if (!Number.isFinite(value)) return;
    const bounded = Math.min(maximum, Math.max(minimum, value));
    normalized[key] = integer ? Math.floor(bounded) : bounded;
  };
  const copyBoolean = (key) => {
    if (typeof settings[key] === "boolean") normalized[key] = settings[key];
  };
  const copyPositiveInteger = (key) => {
    if (!has(key)) return;
    const value = Number(settings[key]);
    if (!Number.isFinite(value) || value < 1) return;
    normalized[key] = Math.floor(value);
  };

  if (["watchlater", "pubdate", "duration"].includes(settings.sortMode)) normalized.sortMode = settings.sortMode;
  if (["asc", "desc"].includes(settings.sortDirection)) normalized.sortDirection = settings.sortDirection;
  if ([core.BROWSE_MODES.CATEGORIES, core.BROWSE_MODES.UP].includes(settings.browseMode)) normalized.browseMode = settings.browseMode;
  if ([core.VIDEO_VIEW_MODES.CARDS, core.VIDEO_VIEW_MODES.LIST].includes(settings.videoViewMode)) normalized.videoViewMode = settings.videoViewMode;
  if (has("collapsedCategoryIds")) normalized.collapsedCategoryIds = core.normalizeCollapsedCategoryIds(settings.collapsedCategoryIds);
  copyNumber("batchSize", 20, 100, true);
  copyNumber("detailConcurrency", 1, 6, true);
  copyNumber("llmBatchSize", 1, 100, true);
  copyNumber("llmLimit", 0, 10000, false);
  copyNumber("llmTemperature", 0, 2, false);
  copyPositiveInteger("categorySampleLimit");
  copyNumber("llmAutoClassifyThreshold", 1, 10000, true);
  copyNumber("llmAutoClassifyLastRunAt", 0, Number.MAX_SAFE_INTEGER, false);
  copyNumber("llmAutoClassifyLastImported", 0, MAX_BACKUP_RECORDS, true);
  copyNumber("onboardingVersion", 0, 100, true);
  copyNumber("categoryListUpdatedAt", 0, Number.MAX_SAFE_INTEGER, false);
  copyBoolean("detailFetchEnabled");
  copyBoolean("llmIncludeAll");
  copyBoolean("llmUseResponseFormat");

  if (typeof settings.llmApiFormat === "string") normalized.llmApiFormat = core.normalizeLlmApiFormat(settings.llmApiFormat);
  if (["off", "daily", "weekly", "threshold"].includes(settings.llmAutoClassifyMode)) normalized.llmAutoClassifyMode = settings.llmAutoClassifyMode;
  const onboardingMethod = settings.onboardingMethod === "prompt" ? "api" : settings.onboardingMethod;
  const onboardingStage = settings.onboardingStage === "setup-prompt" ? "setup-api" : settings.onboardingStage;
  if (["", "categories", "api"].includes(onboardingMethod)) normalized.onboardingMethod = onboardingMethod;
  if (["login", "setup", "setup-categories", "setup-api", "setup-result", "guide", "classify", "complete"].includes(onboardingStage)) normalized.onboardingStage = onboardingStage;
  copyBoolean("onboardingEligible");
  copyBoolean("onboardingCompleted");
  copyString("llmBaseUrl", 2048);
  copyString("llmModel", 200);
  copyString("llmApiKey", 4096);
  copyString("llmAutoClassifyLastStatus", 500);
  copyString("categoryListSource", 80);
  copyString("classificationRepairVersion", 80);
  return normalized;
}

function normalizeBackupArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("数据备份中的 " + name + " 必须是数组");
  if (value.length > MAX_BACKUP_RECORDS) throw new Error("数据备份中的 " + name + " 数量过多");
  return value;
}

function backupTimestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function backupValueIsUseful(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return core.normalizeText(value) !== "";
  return true;
}

function mergeBackupVideos(importedVideos, existingVideos) {
  const existingByBvid = new Map((existingVideos || []).map((video) => [video.bvid, video]));
  const mergedByBvid = new Map(existingByBvid);
  let imported = 0;
  let skipped = 0;

  (importedVideos || []).forEach((item) => {
    const bvid = core.normalizeBvid(item && (item.bvid || item.pageUrl));
    if (!bvid) {
      skipped += 1;
      return;
    }
    try {
      const existing = existingByBvid.get(bvid);
      const incomingLastSeen = backupTimestamp(item.lastSeenAt, 0);
      const existingLastSeen = backupTimestamp(existing && existing.lastSeenAt, 0);
      const incoming = Object.assign({}, item, { bvid });
      if (existing) {
        ["tags", "pageParts"].forEach((field) => {
          if (Array.isArray(existing[field]) || Array.isArray(incoming[field])) {
            const existingValues = Array.isArray(existing[field]) ? existing[field] : [];
            const incomingValues = Array.isArray(incoming[field]) ? incoming[field] : [];
            incoming[field] = core.uniqueStrings(existingValues.concat(incomingValues));
          }
        });
        if (existingLastSeen > incomingLastSeen) {
          BACKUP_VIDEO_METADATA_FIELDS.forEach((field) => {
            if (["tags", "pageParts"].includes(field)) return;
            if (backupValueIsUseful(existing[field])) incoming[field] = existing[field];
          });
        }
      }
      const now = incomingLastSeen || existingLastSeen || Date.now();
      const merged = core.canonicalizeVideo(incoming, existing, { now });
      const incomingFirstSeen = backupTimestamp(incoming.firstSeenAt, now);
      const mergedLastSeen = backupTimestamp(incoming.lastSeenAt, now);
      merged.firstSeenAt = existing && existing.firstSeenAt
        ? Math.min(existing.firstSeenAt, incomingFirstSeen)
        : incomingFirstSeen;
      merged.lastSeenAt = existing && existing.lastSeenAt
        ? Math.max(existing.lastSeenAt, mergedLastSeen)
        : mergedLastSeen;
      merged.presentInWatchlater = existing
        ? existing.presentInWatchlater !== false || incoming.presentInWatchlater !== false
        : incoming.presentInWatchlater !== false;
      merged.sourceHash = core.computeSourceHash(merged);
      mergedByBvid.set(bvid, merged);
      imported += 1;
    } catch (error) {
      skipped += 1;
    }
  });

  return { items: Array.from(mergedByBvid.values()), imported, skipped };
}

function normalizeBackupJobs(jobs, videosByBvid) {
  const normalized = [];
  let skipped = 0;
  (jobs || []).forEach((job) => {
    const id = core.normalizeText(job && job.id);
    if (!id) {
      skipped += 1;
      return;
    }
    const type = core.normalizeText(job.type) || "detail";
    const bvid = core.normalizeBvid(job.bvid) || "";
    const video = bvid && videosByBvid ? videosByBvid.get(bvid) : null;
    if (type === "detail" && bvid && (!video || video.presentInWatchlater === false)) {
      skipped += 1;
      return;
    }
    const status = ["pending", "running", "done", "failed"].includes(job.status) ? job.status : "pending";
    normalized.push({
      id,
      type,
      bvid,
      reason: core.truncateText(job.reason, 160),
      status: status === "running" ? "pending" : status,
      attempts: Math.max(0, Number(job.attempts) || 0),
      createdAt: backupTimestamp(job.createdAt, Date.now()),
      updatedAt: backupTimestamp(job.updatedAt, Date.now()),
      error: core.truncateText(job.error, 240)
    });
  });
  return { items: normalized, skipped };
}

function normalizeBackupMeta(meta) {
  const normalized = [];
  let skipped = 0;
  (meta || []).forEach((item) => {
    const key = core.normalizeText(item && item.key);
    if (!key) {
      skipped += 1;
      return;
    }
    normalized.push({ key, value: item.value });
  });
  return { items: normalized, skipped };
}

async function importDataBackup(payload) {
  const backup = normalizeDataBackup(payload);
  const config = await getConfig();
  const current = await db.snapshot();
  const videoResult = mergeBackupVideos(backup.videos, current.videos);
  const classificationsByBvid = new Map((current.classifications || []).map((item) => [item.bvid, item]));
  const categories = preserveManualCategoryDefinitions(backup.categories, config.categories, current.classifications);
  const parsed = core.parseClassificationPayload({ classifications: backup.classifications });
  const validated = core.validateClassificationItems(parsed.items, categories, videoResult.items);
  const rawClassificationsByBvid = new Map((backup.classifications || [])
    .map((item) => [core.normalizeBvid(item && item.bvid), item])
    .filter(([bvid]) => Boolean(bvid)));
  const videosByBvid = new Map(videoResult.items.map((video) => [video.bvid, video]));
  let importedClassifications = 0;
  let skippedClassifications = 0;
  const classificationUpdates = new Map();

  validated.items.forEach((item) => {
    const video = videosByBvid.get(item.bvid);
    if (!video) {
      skippedClassifications += 1;
      return;
    }
    const existing = classificationUpdates.get(item.bvid) || classificationsByBvid.get(item.bvid);
    if (existing && core.isManualClassification(existing)) {
      skippedClassifications += 1;
      return;
    }
    const raw = rawClassificationsByBvid.get(item.bvid) || {};
    const incoming = Object.assign({}, item, {
      sourceType: core.classificationSourceType(raw) || item.sourceType,
      manualOverride: Boolean(raw.manualOverride) || core.classificationSourceType(raw) === core.CLASSIFICATION_SOURCE_TYPES.MANUAL,
      classifierVersion: core.normalizeText(raw.classifierVersion) || item.classifierVersion,
      sourceHashAtClassification: core.normalizeText(raw.sourceHashAtClassification)
    });
    const classifiedAt = backupTimestamp(raw.classifiedAt, Date.now());
    const merged = core.mergeClassification(existing, incoming, video, { now: classifiedAt });
    if (merged.skippedImport) {
      skippedClassifications += 1;
      return;
    }
    classificationUpdates.set(item.bvid, Object.assign({}, merged, { classifiedAt }));
    importedClassifications += 1;
  });

  const importedSettings = Object.assign({}, core.DEFAULT_SETTINGS, normalizeBackupSettings(Object.assign({}, config.settings, backup.settings)), {
    categoryListUpdatedAt: Date.now(),
    categoryListSource: "backup"
  });
  await chromeStorageSet({ settings: importedSettings, categories });
  await db.putMany("videos", videoResult.items);
  await db.putMany("classifications", Array.from(classificationUpdates.values()));

  const jobResult = normalizeBackupJobs(backup.jobs, videosByBvid);
  const metaResult = normalizeBackupMeta(backup.meta);
  const staleDetailJobs = (current.jobs || []).filter((job) => {
    if (core.normalizeText(job && job.type) !== "detail") return false;
    const video = videosByBvid.get(core.normalizeBvid(job && job.bvid));
    return Boolean(video && video.presentInWatchlater === false);
  });
  for (const job of staleDetailJobs) await db.remove("jobs", job.id);
  await db.putMany("jobs", jobResult.items);
  await db.putMany("meta", metaResult.items);
  await cleanupDeletedCategoryReferences(new Set(config.categories.map((category) => category.id)
    .filter((id) => !categories.some((category) => category.id === id))), categories);
  await configureAutoLlmAlarm(importedSettings, true);

  const warnings = [...parsed.warnings, ...validated.warnings];
  if (videoResult.skipped) warnings.push("有 " + videoResult.skipped + " 个视频记录无法导入");
  if (jobResult.skipped) warnings.push("有 " + jobResult.skipped + " 个处理任务无法导入");
  if (staleDetailJobs.length) warnings.push("已清理 " + staleDetailJobs.length + " 个已移除视频的详情任务");
  if (metaResult.skipped) warnings.push("有 " + metaResult.skipped + " 个扩展元数据无法导入");
  if (skippedClassifications) warnings.push("有 " + skippedClassifications + " 项视频分类被跳过，其中可能包含已有手动确认");
  setProgress({
    status: "idle",
    message: "数据备份导入完成：更新 " + videoResult.imported + " 个视频，导入 " + importedClassifications + " 项分类",
    pending: 0,
    running: 0,
    updatedAt: Date.now()
  });
  return Object.assign(await getState(), {
    dataImportResult: {
      videos: videoResult.imported,
      skippedVideos: videoResult.skipped,
      classifications: importedClassifications,
      skippedClassifications,
      categories: categories.length,
      jobs: jobResult.items.length,
      removedJobs: staleDetailJobs.length,
      meta: metaResult.items.length,
      warnings: warnings.slice(0, 100)
    }
  });
}

async function scanWatchlater(message) {
  setProgress({ status: "running", message: "正在扫描稍后再看列表", running: 1 });
  let apiItems = [];
  let apiError = "";
  let apiCode = null;
  let apiSucceeded = false;
  let loginStatus = "unknown";
  try {
    apiItems = await fetchWatchlaterFromApi();
    apiSucceeded = true;
    loginStatus = "logged_in";
  } catch (error) {
    apiError = error && error.message ? error.message : String(error);
    apiCode = error && Number.isFinite(Number(error.biliCode)) ? Number(error.biliCode) : null;
    if (apiCode === -101) loginStatus = "logged_out";
  }

  const domItems = Array.isArray(message.domItems) ? message.domItems : [];
  const itemsByBvid = new Map();
  [...apiItems, ...domItems].forEach((item) => {
    const bvid = core.normalizeBvid(item && (item.bvid || item.pageUrl));
    if (!bvid) return;
    itemsByBvid.set(bvid, Object.assign({}, itemsByBvid.get(bvid) || {}, item, { bvid, presentInWatchlater: true }));
  });

  const markRemoved = apiSucceeded;
  const upsertResult = await upsertVideoItems(Array.from(itemsByBvid.values()), { markRemoved, skipState: true });
  const scanCount = itemsByBvid.size;
  const newCount = upsertResult.scanResult ? upsertResult.scanResult.newCount : 0;
  const changedCount = upsertResult.scanResult ? upsertResult.scanResult.changedCount : 0;
  const removedCount = upsertResult.scanResult ? upsertResult.scanResult.removedCount || 0 : 0;
  const scanConfig = await getConfig();
  const onboardingPending = scanConfig.settings.onboardingEligible === true && scanConfig.settings.onboardingCompleted !== true;
  const skipAutoClassify = Boolean(message.skipAutoClassify) || onboardingPending;
  const autoState = skipAutoClassify
    ? Object.assign(await getState(), {
      autoClassifyResult: { classified: 0, skippedManual: 0, reclassifiedManual: 0, unchanged: 0, skipped: true }
    })
    : await autoClassify({ silent: true, unclassifiedOnly: true });
  const autoResult = autoState.autoClassifyResult || {};
  setProgress({
    status: "idle",
    message: apiSucceeded
      ? "同步完成 · 共 " + scanCount + " 个视频，新增 " + newCount + " 个，变化 " + changedCount + " 个，移除 " + removedCount + " 个" + (autoResult.skipped ? "；暂不分类视频" : "；完成初步分类 " + (autoResult.classified || 0) + " 个")
      : "已同步页面可见的 " + scanCount + " 个视频" + (autoResult.skipped ? "；暂不分类视频" : "；完成初步分类 " + (autoResult.classified || 0) + " 个") + "；B站列表接口不可用：" + apiError,
    running: 0,
    updatedAt: Date.now()
  });
  return Object.assign({
    source: apiSucceeded ? "api+dom" : "dom",
    apiError,
    apiCode,
    loginStatus
  }, upsertResult, autoState);
}

async function upsertVideoItems(items, options) {
  const upsert = await db.upsertVideos(items);
  const scanResult = {
    scannedCount: upsert.results.length,
    newCount: upsert.results.filter((result) => result.isNew).length,
    changedCount: upsert.results.filter((result) => result.sourceChanged).length,
    newBvids: upsert.results.filter((result) => result.isNew).map((result) => result.video.bvid),
    changedBvids: upsert.results.filter((result) => result.sourceChanged).map((result) => result.video.bvid)
  };
  const bvids = upsert.results.map((item) => item.video.bvid);
  if (options && options.markRemoved) {
    const removedBvids = await db.markRemovedExcept(bvids);
    scanResult.removedCount = removedBvids.length;
    scanResult.removedBvids = removedBvids;
  }

  if (options && options.skipState) return { scanResult };
  return Object.assign(await getState(), { scanResult });
}

async function queueMissingVideoDetails(options) {
  const settings = options || {};
  const config = await getConfig();
  if (!config.settings.detailFetchEnabled) {
    setProgress({ status: "idle", message: "详情更新已关闭", running: 0 });
    return Object.assign(await getState(), {
      detailQueueResult: { candidates: 0, queued: 0, disabled: true }
    });
  }

  const videos = await db.getAll("videos");
  const requestedBvids = new Set(Array.isArray(settings.bvids) ? core.uniqueStrings(settings.bvids) : []);
  const missingDetailBvids = videos
    .filter((video) => video && video.presentInWatchlater !== false)
    .filter((video) => !requestedBvids.size || requestedBvids.has(video.bvid))
    .filter(shouldFetchDetails)
    .map((video) => video.bvid);
  const queued = await db.queueJobs("detail", missingDetailBvids, settings.reason || "manual");
  const jobs = await db.getAll("jobs");
  const activeJobs = jobs.filter((job) => job.type === "detail" && (job.status === "pending" || job.status === "running"));

  if (activeJobs.length) {
    setProgress({ status: "running", message: "已排队 " + activeJobs.length + " 个视频详情", pending: activeJobs.length, running: 0, done: 0, failed: 0 });
    startDetailQueue();
    if (settings.waitForCompletion && detailRunPromise) await detailRunPromise;
  } else {
    setProgress({ status: "idle", message: "没有缺失详情的视频", pending: 0, running: 0 });
  }

  return Object.assign(await getState(), {
    detailQueueResult: {
      candidates: missingDetailBvids.length,
      queued,
      pending: activeJobs.length
    }
  });
}

function shouldFetchDetails(video) {
  if (!video) return false;
  if (["viewCount", "danmakuCount", "likeCount", "coinCount", "favoriteCount", "shareCount", "replyCount"]
    .some((field) => video[field] == null)) return true;
  if (!video.tname || !video.desc || !Array.isArray(video.tags) || !video.tags.length) return true;
  if (!video.upName || !Array.isArray(video.pageParts) || !video.pageParts.length) return true;
  return false;
}

async function fetchWatchlaterFromApi() {
  const endpoints = [
    "https://api.bilibili.com/x/v2/history/toview?jsonp=jsonp",
    "https://api.bilibili.com/x/v2/history/toview"
  ];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: { "accept": "application/json,text/plain,*/*" }
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const json = await response.json();
      if (json.code !== 0) {
        const error = new Error(json.message || ("B站接口返回 code " + json.code));
        error.biliCode = Number(json.code);
        throw error;
      }
      const list = findVideoList(json.data);
      return list.map((item, index) => convertBiliApiVideo(item, index)).filter(Boolean);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.biliCode === -101) break;
    }
  }
  throw lastError || new Error("稍后再看接口不可用");
}

function findVideoList(data) {
  if (!data) return [];
  if (Array.isArray(data.list)) return data.list;
  if (data.list && Array.isArray(data.list.list)) return data.list.list;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data)) return data;
  return [];
}

function convertBiliApiVideo(item, index) {
  const bvid = core.normalizeBvid(item && (item.bvid || item.bv_id || item.uri || item.redirect_url));
  if (!bvid) return null;
  const owner = item.owner || item.author || {};
  const stat = item.stat || {};
  const duration = Number(item.duration) || 0;
  const rawProgress = Number(item.progress);
  const hasProgress = Number.isFinite(rawProgress);
  return {
    bvid,
    oid: item.oid,
    aid: item.aid,
    title: item.title || item.name,
    pageUrl: item.uri || item.redirect_url || ("https://www.bilibili.com/video/" + bvid),
    upName: owner.name || item.author_name || item.owner_name,
    upMid: owner.mid || item.mid,
    coverUrl: item.pic || item.cover,
    tname: item.tname || item.typename || item.type_name,
    desc: item.desc,
    duration,
    viewCount: stat.view,
    danmakuCount: stat.danmaku,
    likeCount: stat.like,
    coinCount: stat.coin,
    favoriteCount: stat.favorite,
    shareCount: stat.share,
    replyCount: stat.reply,
    watchProgress: hasProgress ? rawProgress : undefined,
    isWatched: hasProgress ? rawProgress < 0 || duration > 0 && rawProgress >= duration : undefined,
    pubdate: item.pubdate || item.pubtime || item.ctime,
    watchlaterAddedAt: item.add_at || item.addAt || item.add_time || item.addtime || item.view_at,
    watchlaterOrder: Number.isFinite(Number(index)) ? Number(index) : undefined,
    pageParts: Array.isArray(item.pages) ? item.pages.map((page) => page.part).filter(Boolean) : [],
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => tag.tag_name || tag.name || tag) : [],
    presentInWatchlater: true
  };
}

async function removeFromWatchlater(message) {
  const bvid = core.normalizeBvid(message && message.bvid);
  if (!bvid) throw new Error("缺少 bvid");

  let video = await db.get("videos", bvid);
  if (!video) throw new Error("本地记录中没有这个视频：" + bvid);

  let aid = video.aid || video.oid;
  if (!aid) {
    const details = await fetchVideoDetails(bvid);
    const upsert = await db.upsertVideos([Object.assign({}, details, { bvid, presentInWatchlater: true })]);
    video = upsert.results[0] ? upsert.results[0].video : Object.assign({}, video, details);
    aid = video.aid || video.oid;
  }
  if (!aid) throw new Error("缺少 aid，无法从稍后再看移除：" + bvid);

  await requestWatchlaterRemove(aid);
  await db.markRemoved(bvid);
  return Object.assign(await getState(), {
    removeResult: { bvid, aid }
  });
}

async function bulkRemoveFromWatchlater(message) {
  const bvids = Array.from(new Set((Array.isArray(message && message.bvids) ? message.bvids : [])
    .map((bvid) => core.normalizeBvid(bvid))
    .filter(Boolean)));
  if (!bvids.length) throw new Error("没有选择视频");

  const removedBvids = [];
  const failedItems = [];
  for (const bvid of bvids) {
    try {
      let video = await db.get("videos", bvid);
      if (!video) throw new Error("本地记录中没有这个视频：" + bvid);

      let aid = normalizePositiveAid(video);
      if (!aid) {
        const details = await fetchVideoDetails(bvid);
        const upsert = await db.upsertVideos([Object.assign({}, details, { bvid, presentInWatchlater: true })]);
        video = upsert.results[0] ? upsert.results[0].video : Object.assign({}, video, details);
        aid = normalizePositiveAid(video);
      }
      if (!aid) throw new Error("缺少 aid，无法从稍后再看移除：" + bvid);

      await requestWatchlaterRemove(aid);
      await db.markRemoved(bvid);
      removedBvids.push(bvid);
    } catch (error) {
      failedItems.push({ bvid, reason: errorMessage(error) });
    }
  }

  return Object.assign(await getState(), {
    bulkRemoveResult: {
      removedBvids,
      removed: removedBvids.length,
      successCount: removedBvids.length,
      failed: failedItems.length,
      failureCount: failedItems.length,
      failedItems
    }
  });
}

async function createFavoriteFolderAndAdd(message) {
  const title = core.truncateText(core.normalizeText(message && message.title), FAVORITE_TITLE_MAX_LENGTH);
  if (!title) throw new Error("收藏夹名称不能为空");

  const bvids = Array.from(new Set(core.uniqueStrings(message && message.bvids)
    .map((bvid) => core.normalizeBvid(bvid))
    .filter(Boolean)));
  if (!bvids.length) throw new Error("请先选择视频");

  const csrf = await getBiliCsrf();
  const folder = await requestFavoriteFolderCreate(title, csrf);
  const skipped = [];
  const failed = [];
  const candidates = [];
  const seenAids = new Set();

  for (const bvid of bvids) {
    let video = await db.get("videos", bvid);
    if (!video) {
      failed.push({ bvid, reason: "本地记录不存在" });
      continue;
    }

    let aid = normalizePositiveAid(video);
    if (!aid) {
      try {
        const details = await fetchVideoDetails(bvid);
        const upsert = await db.upsertVideos([Object.assign({}, details, { bvid, presentInWatchlater: true })]);
        video = upsert.results[0] ? upsert.results[0].video : Object.assign({}, video, details);
        aid = normalizePositiveAid(video);
      } catch (error) {
        failed.push({ bvid, reason: "视频详情补充失败：" + errorMessage(error) });
        continue;
      }
    }

    if (!aid) {
      skipped.push({ bvid, reason: "缺少 aid" });
      continue;
    }
    if (seenAids.has(aid)) {
      skipped.push({ bvid, reason: "重复视频" });
      continue;
    }
    seenAids.add(aid);
    candidates.push({ bvid, aid });
  }

  const added = [];
  for (const item of candidates) {
    try {
      await requestFavoriteResourceDeal(folder.id, item.aid, csrf);
      added.push({ bvid: item.bvid, aid: item.aid });
    } catch (error) {
      const reason = errorMessage(error);
      const target = isFavoriteAlreadyError(error) ? skipped : failed;
      target.push({ bvid: item.bvid, reason });
    }
  }

  const favoriteResult = {
    folder: { id: folder.id, title: folder.title, privacy: 1 },
    requested: bvids.length,
    eligible: candidates.length,
    added: added.length,
    skipped: skipped.length,
    failed: failed.length,
    skippedItems: skipped,
    failedItems: failed
  };
  return Object.assign(await getState(), { favoriteResult });
}

function normalizePositiveAid(video) {
  const aid = Number(video && video.aid);
  if (Number.isSafeInteger(aid) && aid > 0) return aid;
  const oid = Number(video && video.oid);
  return Number.isSafeInteger(oid) && oid > 0 ? oid : 0;
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

async function requestFavoriteFolderCreate(title, csrf) {
  const json = await requestBiliFormWithPageFallback(
    "https://api.bilibili.com/x/v3/fav/folder/add",
    { title, intro: "", privacy: "1", csrf },
    "B站创建收藏夹"
  );
  const id = Number(json && json.data && (json.data.id || json.data.media_id));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("B站创建收藏夹未返回有效 ID");
  return {
    id,
    title: core.normalizeText(json.data.title) || title
  };
}

async function requestFavoriteResourceDeal(mediaId, aid, csrf) {
  await requestBiliFormWithPageFallback(
    "https://api.bilibili.com/x/v3/fav/resource/deal",
    {
      rid: String(aid),
      type: "2",
      add_media_ids: String(mediaId),
      del_media_ids: "",
      csrf
    },
    "B站批量加入收藏夹"
  );
}

async function requestBiliFormWithPageFallback(url, fields, label) {
  try {
    return await postBiliForm(url, fields, label);
  } catch (error) {
    if (!shouldRetryBiliPageRequest(error)) throw error;
    return requestBiliFormFromPage(url, fields, label);
  }
}

async function postBiliForm(url, fields, label) {
  const body = new URLSearchParams();
  Object.entries(fields || {}).forEach(([key, value]) => body.set(key, String(value == null ? "" : value)));
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    referrer: "https://www.bilibili.com/",
    referrerPolicy: "strict-origin-when-cross-origin",
    headers: {
      "accept": "application/json,text/plain,*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: body.toString()
  });
  if (!response.ok) throw new Error(label + " HTTP " + response.status);
  return assertBiliSuccess(await response.json(), label);
}

async function requestBiliFormFromPage(url, fields, label) {
  let tab = await findBiliPageTab();
  let createdTab = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://www.bilibili.com/", active: false });
    createdTab = true;
  }

  try {
    if (!tab || tab.id == null) throw new Error("无法打开 B站页面执行收藏操作");
    await waitForTabComplete(tab.id);
    await delay(createdTab ? 500 : 120);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [{ url, fields, label }],
      func: async (request) => {
        const body = new URLSearchParams();
        Object.entries(request.fields || {}).forEach(([key, value]) => body.set(key, String(value == null ? "" : value)));
        const response = await fetch(request.url, {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "application/json,text/plain,*/*",
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
          },
          body: body.toString()
        });
        if (!response.ok) throw new Error(request.label + "页面接口 HTTP " + response.status);
        const json = await response.json();
        if (!json || json.code !== 0) {
          const error = new Error(request.label + "失败：" + (json && json.message ? json.message : "code " + (json && json.code)));
          error.biliCode = Number(json && json.code);
          throw error;
        }
        return json;
      }
    });
    if (!results || !results[0] || !results[0].result) {
      throw new Error(label + "页面请求没有返回成功结果");
    }
    return results[0].result;
  } finally {
    if (createdTab && tab && tab.id != null) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function assertBiliSuccess(json, label) {
  if (!json || json.code !== 0) {
    const error = new Error(label + "失败：" + (json && json.message ? json.message : "code " + (json && json.code)));
    error.biliCode = Number(json && json.code);
    throw error;
  }
  return json;
}

function shouldRetryBiliPageRequest(error) {
  return /HTTP 412|Failed to fetch|Referrer|referrer|CORS|TypeError/i.test(errorMessage(error));
}

function isFavoriteAlreadyError(error) {
  return /已收藏|已经收藏|已在收藏夹|already\s*(?:be\s*)?favorit|duplicate/i.test(errorMessage(error));
}

async function findBiliPageTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/*" });
  return tabs && tabs.length ? tabs[0] : null;
}

async function requestWatchlaterRemove(aid) {
  const csrf = await getBiliCsrf();
  try {
    await postWatchlaterRemove(aid, csrf);
  } catch (error) {
    if (!shouldRetryBiliPageRequest(error)) throw error;
    await requestBiliFormFromPage(
      "https://api.bilibili.com/x/v2/history/toview/del",
      { aid, csrf },
      "B站移出稍后再看"
    );
  }
}

async function postWatchlaterRemove(aid, csrf) {
  const body = new URLSearchParams();
  body.set("aid", String(aid));
  body.set("csrf", csrf);
  const response = await fetch("https://api.bilibili.com/x/v2/history/toview/del", {
    method: "POST",
    credentials: "include",
    referrer: "https://www.bilibili.com/",
    referrerPolicy: "strict-origin-when-cross-origin",
    headers: {
      "accept": "application/json,text/plain,*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: body.toString()
  });
  if (!response.ok) {
    throw new Error("B站删除接口 HTTP " + response.status);
  }
  const json = await response.json();
  if (!json || json.code !== 0) {
    throw new Error("B站删除失败：" + (json && json.message ? json.message : "code " + (json && json.code)));
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error("等待 B站稍后再看页面加载超时")), 15000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    }
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete") finish();
      })
      .catch(finish);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBiliCsrf() {
  if (!chrome.cookies || !chrome.cookies.get) {
    throw new Error("缺少 cookies 权限，无法读取 B站 csrf");
  }
  const cookie = await chrome.cookies.get({
    url: "https://www.bilibili.com/",
    name: "bili_jct"
  });
  if (!cookie || !cookie.value) {
    throw new Error("未找到 bili_jct，请确认当前 Chrome 已登录 B站");
  }
  return cookie.value;
}

function startDetailQueue() {
  if (!detailRunPromise) {
    detailRunPromise = processDetailQueue()
      .catch((error) => setProgress({ status: "error", message: error && error.message ? error.message : String(error), running: 0 }))
      .finally(() => {
        detailRunPromise = null;
      });
  }
}

async function processDetailQueue() {
  const config = await getConfig();
  const concurrency = config.settings.detailConcurrency || 3;
  let pending = await db.pendingJobs("detail");
  setProgress({ status: pending.length ? "running" : "idle", message: pending.length ? "正在更新视频详情" : "没有待更新详情", pending: pending.length, running: 0, done: 0, failed: 0 });

  while (pending.length) {
    const chunk = pending.slice(0, concurrency);
    pending = pending.slice(concurrency);
    setProgress({ running: chunk.length, pending: pending.length });
    await Promise.all(chunk.map(processDetailJob));
  }

  setProgress({ status: "idle", message: "详情更新完成", pending: 0, running: 0 });
}

async function processDetailJob(job) {
  await db.updateJob(job.id, { status: "running", attempts: (job.attempts || 0) + 1 });
  try {
    const details = await fetchVideoDetails(job.bvid);
    await db.upsertVideos([Object.assign({}, details, { bvid: job.bvid, presentInWatchlater: true })]);
    await db.updateJob(job.id, { status: "done", error: "" });
    setProgress({ done: progress.done + 1 });
  } catch (error) {
    await db.updateJob(job.id, { status: "failed", error: error && error.message ? error.message : String(error) });
    setProgress({ failed: progress.failed + 1 });
  }
}

async function fetchVideoDetails(bvid) {
  const view = await fetchJson("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid));
  if (!view || view.code !== 0 || !view.data) {
    return fetchVideoDetailsFromHtml(bvid);
  }

  let tags = [];
  try {
    const tagJson = await fetchJson("https://api.bilibili.com/x/tag/archive/tags?bvid=" + encodeURIComponent(bvid));
    if (tagJson && tagJson.code === 0 && Array.isArray(tagJson.data)) {
      tags = tagJson.data.map((tag) => tag.tag_name || tag.name).filter(Boolean);
    }
  } catch (error) {
    tags = [];
  }

  const data = view.data;
  const owner = data.owner || {};
  const stat = data.stat || {};
  return {
    bvid: data.bvid || bvid,
    oid: data.aid,
    aid: data.aid,
    title: data.title,
    pageUrl: "https://www.bilibili.com/video/" + (data.bvid || bvid),
    upName: owner.name,
    upMid: owner.mid,
    coverUrl: data.pic,
    tname: data.tname_v2 || data.tname,
    tags,
    desc: data.desc,
    duration: data.duration,
    viewCount: stat.view,
    danmakuCount: stat.danmaku,
    likeCount: stat.like,
    coinCount: stat.coin,
    favoriteCount: stat.favorite,
    shareCount: stat.share,
    replyCount: stat.reply,
    pubdate: data.pubdate || data.ctime,
    pageParts: Array.isArray(data.pages) ? data.pages.map((page) => page.part).filter(Boolean) : [],
    presentInWatchlater: true
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: "include",
    headers: { "accept": "application/json,text/plain,*/*" }
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function fetchVideoDetailsFromHtml(bvid) {
  const response = await fetch("https://www.bilibili.com/video/" + encodeURIComponent(bvid), {
    credentials: "include",
    headers: { "accept": "text/html,*/*" }
  });
  if (!response.ok) throw new Error("详情页 HTTP " + response.status);
  const html = await response.text();
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i);
  const initialMatch = html.match(/window\.__INITIAL_STATE__=([\s\S]*?);\(function\(\)/);
  let parsed = null;
  if (initialMatch) {
    try {
      parsed = JSON.parse(initialMatch[1]);
    } catch (error) {
      parsed = null;
    }
  }
  const videoData = parsed && (parsed.videoData || parsed.videoInfo || {});
  const stat = (videoData && videoData.stat) || {};
  const aid = videoData && videoData.aid || parsed && parsed.aid;
  return {
    bvid,
    oid: aid,
    aid,
    title: videoData && videoData.title ? videoData.title : cleanHtmlText(titleMatch && titleMatch[1]),
    pageUrl: "https://www.bilibili.com/video/" + bvid,
    desc: videoData && videoData.desc ? videoData.desc : cleanHtmlText(descMatch && descMatch[1]),
    tname: videoData && videoData.tname,
    coverUrl: videoData && videoData.pic,
    duration: videoData && videoData.duration,
    viewCount: stat.view,
    danmakuCount: stat.danmaku,
    likeCount: stat.like,
    coinCount: stat.coin,
    favoriteCount: stat.favorite,
    shareCount: stat.share,
    replyCount: stat.reply,
    pubdate: videoData && (videoData.pubdate || videoData.ctime),
    presentInWatchlater: true
  };
}

function cleanHtmlText(value) {
  return core.normalizeText(String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/_哔哩哔哩_bilibili$/i, ""));
}

function setProgress(patch) {
  progress = Object.assign({}, progress, patch || {}, { updatedAt: Date.now() });
  chrome.runtime.sendMessage({ type: core.MESSAGE_TYPES.JOB_PROGRESS, progress }).catch(() => {});
}

async function exportCategoryProposal(message) {
  const config = await getConfig();
  const summary = await db.summary();
  const candidates = shuffledCopy(summary.videos
    .filter((video) => video && video.presentInWatchlater !== false));
  const requested = core.normalizeCategorySampleLimit(
    config.settings.categorySampleLimit,
    core.DEFAULT_SETTINGS.categorySampleLimit
  );
  const sample = candidates.slice(0, requested);
  return {
    prompt: core.buildCategoryProposalPrompt(sample, config.categories, { sampleLimit: requested }),
    sampleCount: sample.length,
    totalVideos: candidates.length
  };
}

async function importCategories(message) {
  const config = await getConfig();
  const importedCategories = normalizeImportedCategories(message.payload);
  const classifications = await db.getAll("classifications");
  const categories = preserveManualCategoryDefinitions(importedCategories, config.categories, classifications);
  const previousIds = new Set(config.categories.map((category) => category.id));
  const nextIds = new Set(categories.map((category) => category.id));
  const addedCategoryIds = categories.map((category) => category.id).filter((id) => !previousIds.has(id));
  const removedIds = new Set(Array.from(previousIds).filter((id) => !nextIds.has(id)));
  await chromeStorageSet({ categories });
  await cleanupDeletedCategoryReferences(removedIds, categories);

  const onboardingPending = config.settings.onboardingEligible === true && config.settings.onboardingCompleted !== true;
  const keywordResult = message.skipAutoClassify || onboardingPending
    ? { checked: 0, matchedVideos: 0, addedAssignments: 0, skipped: true }
    : await appendKeywordCategories(addedCategoryIds, categories);

  const data = await chromeStorageGet(["settings"]);
  const settings = Object.assign({}, core.DEFAULT_SETTINGS, data.settings || {}, {
    categoryListUpdatedAt: Date.now(),
    categoryListSource: core.normalizeText(message.source) || "llm"
  });
  await chromeStorageSet({ settings });
  return Object.assign(await getState(), {
    categoryImportResult: {
      imported: categories.length,
      roots: categories.filter((category) => !category.parentId).length,
      source: settings.categoryListSource,
      addedCategoryIds,
      removedCategoryIds: Array.from(removedIds),
      keywordResult
    }
  });
}

function preserveManualCategoryDefinitions(importedCategories, previousCategories, classifications) {
  const categories = importedCategories.map((category) => Object.assign({}, category));
  const nextIds = new Set(categories.map((category) => category.id));
  const previousById = new Map((previousCategories || []).map((category) => [category.id, category]));
  const protectedIds = new Set();

  function protectWithParents(categoryId) {
    let current = previousById.get(categoryId);
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      protectedIds.add(current.id);
      current = current.parentId ? previousById.get(current.parentId) : null;
    }
  }

  (classifications || [])
    .filter((classification) => core.isManualClassification(classification))
    .forEach((classification) => {
      core.uniqueStrings(classification.categoryIds).forEach(protectWithParents);
    });

  (previousCategories || []).forEach((category) => {
    if (!protectedIds.has(category.id) || nextIds.has(category.id)) return;
    categories.push(Object.assign({}, category, { enabled: true }));
    nextIds.add(category.id);
  });
  return categories;
}

function normalizeImportedCategories(payload, options) {
  const settings = Object.assign({ allowSmall: false, ensureFallback: true }, options || {});
  let parsed = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error("分类目录 JSON 无法解析：" + error.message);
    }
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.categories)
      ? parsed.categories
      : [];
  if (!items.length) throw new Error("返回 JSON 中没有 categories 数组");
  if (!settings.allowSmall && items.length < 4) throw new Error("分类目录过少，至少需要 4 个分类");
  if (items.length > 60) throw new Error("分类数量不能超过 60 个");

  const categories = [];
  const seen = new Set();
  items.forEach((item, index) => {
    const id = core.normalizeText(item && item.id).toLowerCase();
    const name = core.truncateText(item && item.name, 30);
    const parentId = core.normalizeText(item && item.parentId).toLowerCase();
    if (!id || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(id)) {
      throw new Error("分类 id 不合法：" + (id || "第 " + (index + 1) + " 项"));
    }
    if (!name) throw new Error("分类名称不能为空：" + id);
    if (seen.has(id)) throw new Error("分类 id 重复：" + id);
    if (parentId === id) throw new Error("分类不能以自己为父级：" + id);
    seen.add(id);
    categories.push({
      id,
      name,
      parentId: parentId || undefined,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : (index + 1) * 10,
      keywords: core.uniqueStrings(Array.isArray(item && item.keywords) ? item.keywords : []).map((keyword) => core.truncateText(keyword, 24)).slice(0, 10),
      enabled: true
    });
  });

  if (settings.ensureFallback && !seen.has("other")) {
    categories.push({ id: "other", name: "其他", order: 900, keywords: [], enabled: true });
    seen.add("other");
  }
  if (settings.ensureFallback && !seen.has("other.todo")) {
    categories.push({ id: "other.todo", name: "暂未归类", parentId: "other", order: 900, keywords: [], enabled: true });
    seen.add("other.todo");
  }
  const otherCategory = categories.find((category) => category.id === "other");
  const todoCategory = categories.find((category) => category.id === "other.todo");
  if (settings.ensureFallback) {
    otherCategory.parentId = undefined;
    todoCategory.parentId = "other";
  }

  categories.forEach((category) => {
    if (category.parentId && !seen.has(category.parentId)) {
      throw new Error("父分类不存在：" + category.id + " -> " + category.parentId);
    }
    let depth = 1;
    let current = category;
    const path = new Set([category.id]);
    while (current.parentId) {
      if (path.has(current.parentId)) throw new Error("分类层级存在循环：" + category.id);
      path.add(current.parentId);
      current = categories.find((item) => item.id === current.parentId);
      depth += 1;
      if (depth > 3) throw new Error("分类最多支持三级：" + category.id);
    }
  });
  const rootCount = categories.filter((category) => !category.parentId).length;
  if (rootCount > 10) throw new Error("一级分类不能超过 10 个");
  return categories;
}

function selectClassificationCandidates(summary, includeAll) {
  const classificationByBvid = new Map(summary.classifications.map((item) => [item.bvid, item]));
  return summary.videos
    .filter((video) => video.presentInWatchlater !== false)
    .filter((video) => {
      const classification = classificationByBvid.get(video.bvid);
      if (core.isManualClassification(classification)) return false;
      return includeAll || core.needsLlmExport(video, classification);
    })
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

async function exportClassifyBatch(message) {
  const initialConfig = await getConfig();
  const initialSummary = await db.summary();
  const includeAll = Boolean(message.includeAll);
  const offset = Math.max(0, Number(message.offset || 0));
  let candidates = selectClassificationCandidates(initialSummary, includeAll);
  if (message.randomize) candidates = shuffledCopy(candidates);
  const limit = exportLimit(message.limit, initialConfig.settings.batchSize, candidates.length);
  const initialBatch = candidates.slice(offset, offset + limit);
  const initialBatchBvids = initialBatch.map((video) => video.bvid);
  const missingDetailBvids = initialBatch.filter(shouldFetchDetails).map((video) => video.bvid);
  if (missingDetailBvids.length) {
    await queueMissingVideoDetails({
      bvids: missingDetailBvids,
      waitForCompletion: true,
      reason: "AI 分类"
    });
  }

  const config = missingDetailBvids.length ? await getConfig() : initialConfig;
  const summary = missingDetailBvids.length ? await db.summary() : initialSummary;
  const latestByBvid = new Map(summary.videos.map((video) => [video.bvid, video]));
  const batch = initialBatchBvids
    .map((bvid) => latestByBvid.get(bvid))
    .filter((video) => video && video.presentInWatchlater !== false);
  return {
    prompt: core.buildClassificationPrompt(batch, config.categories, Object.assign({}, config.settings, {
      keywordReview: !includeAll,
      titleOnly: Boolean(message.titleOnly),
      compact: Boolean(message.compact)
    })),
    batchVideos: batch,
    batchBvids: batch.map((video) => video.bvid),
    countRemaining: Math.max(0, candidates.length - offset),
    totalCandidates: candidates.length,
    offset,
    batchSize: batch.length,
    mergeMode: "replace"
  };
}

function shuffledCopy(items) {
  const result = (items || []).slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function exportLimit(rawLimit, defaultLimit, total) {
  if (rawLimit === "all") return Math.max(0, total);
  const number = Number(rawLimit || defaultLimit || 80);
  if (!Number.isFinite(number)) return Math.min(100, Math.max(1, Number(defaultLimit) || 80));
  return Math.min(100, Math.max(1, number));
}

async function importClassifications(payload, options) {
  const settings = options || {};
  const config = await getConfig();
  const summary = await db.summary();
  const parsed = core.parseClassificationPayload(payload);
  const validated = core.validateClassificationItems(parsed.items, config.categories, summary.videos, {
    expectedBvids: Array.isArray(settings.batchBvids) ? settings.batchBvids : []
  });
  const videosByBvid = new Map(summary.videos.map((video) => [video.bvid, video]));
  let imported = 0;
  let skipped = 0;

  for (const item of validated.items) {
    const video = await db.get("videos", item.bvid) || videosByBvid.get(item.bvid);
    if (!video || video.presentInWatchlater === false) {
      skipped += 1;
      continue;
    }
    const existing = await db.getClassification(item.bvid);
    const incoming = Object.assign({}, item, {
      classifierVersion: core.CLASSIFIER_VERSION,
      manualOverride: false,
      sourceType: core.CLASSIFICATION_SOURCE_TYPES.LLM
    });
    if (settings.mergeMode === "append" && existing && !core.isManualClassification(existing)) {
      incoming.categoryIds = core.uniqueStrings([...(existing.categoryIds || []), ...(item.categoryIds || [])]);
    }
    const merged = core.mergeClassification(existing, incoming, video);
    if (merged.skippedImport) {
      skipped += 1;
      continue;
    }
    await db.putClassification(merged);
    imported += 1;
  }

  return Object.assign(await getState(), {
    importResult: {
      imported,
      skipped,
      warnings: [...parsed.warnings, ...validated.warnings]
    }
  });
}

async function autoClassify(options) {
  const config = await getConfig();
  const selectedCategoryIds = core.uniqueStrings(options && options.selectedCategoryIds);
  if (selectedCategoryIds.length) {
    const targetedResult = await appendKeywordCategories(selectedCategoryIds, config.categories);
    return Object.assign(await getState(), {
      autoClassifyResult: Object.assign({ targeted: true, selectedCategoryIds }, targetedResult)
    });
  }
  const summary = await db.summary();
  const classificationByBvid = new Map(summary.classifications.map((item) => [item.bvid, item]));
  const includeAll = Boolean(options.includeAll);
  const unclassifiedOnly = Boolean(options.unclassifiedOnly);
  let classified = 0;
  let skippedManual = 0;
  let reclassifiedManual = 0;
  let unchanged = 0;

  if (!options.silent) {
    setProgress({ status: "running", message: "正在执行本地自动分类", running: 1 });
  }
  for (const video of summary.videos) {
    if (!video || video.presentInWatchlater === false) continue;
    const existing = classificationByBvid.get(video.bvid);
    const existingSourceType = core.classificationSourceType(existing);
    if (unclassifiedOnly && existing && core.uniqueStrings(existing.categoryIds).length) {
      unchanged += 1;
      continue;
    }
    if (existingSourceType === core.CLASSIFICATION_SOURCE_TYPES.MANUAL) {
      skippedManual += 1;
      continue;
    }
    if (existingSourceType === core.CLASSIFICATION_SOURCE_TYPES.LLM && !core.needsClassification(video, existing) && !options.includeLlm) {
      unchanged += 1;
      continue;
    }
    if (!includeAll && !core.needsClassification(video, existing)) {
      unchanged += 1;
      continue;
    }
    const categoryIds = core.inferCategoryIds(video, config.categories);
    const next = core.mergeClassification(existing, {
      bvid: video.bvid,
      categoryIds,
      confidence: categoryIds.includes("other.todo") ? 0.45 : 0.68,
      reason: "本地关键词规则自动分类",
      classifierVersion: core.LOCAL_CLASSIFIER_VERSION,
      manualOverride: false,
      sourceType: core.CLASSIFICATION_SOURCE_TYPES.KEYWORD
    }, video);
    await db.putClassification(next);
    classified += 1;
  }

  if (!options.silent) {
    setProgress({ status: "idle", message: "本地自动分类完成：写入 " + classified + " 个，跳过手动 " + skippedManual + " 个", running: 0 });
  }
  return Object.assign(await getState(), {
    autoClassifyResult: {
      classified,
      skippedManual,
      reclassifiedManual,
      unchanged
    }
  });
}

async function saveManualClassification(message) {
  const bvid = core.normalizeBvid(message.bvid);
  if (!bvid) throw new Error("缺少 bvid");
  const video = await db.get("videos", bvid);
  if (!video) throw new Error("本地记录中没有这个视频：" + bvid);
  const config = await getConfig();
  const validCategoryIds = core.uniqueStrings(message.categoryIds)
    .filter((id) => config.categories.some((category) => category.id === id && category.enabled !== false));
  const classification = core.mergeClassification(await db.getClassification(bvid), {
    bvid,
    categoryIds: validCategoryIds.length ? validCategoryIds : ["other.todo"],
    confidence: 1,
    reason: "手动确认",
    manualOverride: true,
    sourceType: core.CLASSIFICATION_SOURCE_TYPES.MANUAL
  }, video, { forceManualOverride: true });
  await db.putClassification(classification);
  return getState();
}

async function bulkUpdateClassifications(message) {
  const bvids = core.uniqueStrings(message.bvids).map(core.normalizeBvid).filter(Boolean);
  if (!bvids.length) throw new Error("没有选择视频");
  const action = core.normalizeText(message.action);
  const config = await getConfig();
  const validIds = new Set(config.categories.filter((category) => category.enabled !== false).map((category) => category.id));
  const videos = await db.getAll("videos");
  const videosByBvid = new Map(videos.map((video) => [video.bvid, video]));
  const categoryId = core.normalizeText(message.categoryId);
  if (action === "add" && !validIds.has(categoryId)) throw new Error("请选择有效分类");

  let updated = 0;
  for (const bvid of bvids) {
    const video = videosByBvid.get(bvid);
    if (!video) continue;
    const existing = await db.getClassification(bvid);
    const categoryIds = action === "clear"
      ? []
      : core.uniqueStrings([...(existing && existing.categoryIds || []), categoryId]).filter((id) => validIds.has(id));
    const classification = core.mergeClassification(existing, {
      bvid,
      categoryIds,
      confidence: 1,
      reason: action === "clear" ? "批量清除分类" : "批量添加分类",
      manualOverride: true,
      sourceType: core.CLASSIFICATION_SOURCE_TYPES.MANUAL
    }, video, { forceManualOverride: true });
    await db.putClassification(classification);
    updated += 1;
  }

  return Object.assign(await getState(), {
    bulkUpdateResult: { updated, action }
  });
}

async function addCategory(message) {
  const config = await getConfig();
  const name = core.normalizeText(message.name);
  if (!name) throw new Error("分类名称不能为空");
  const parentId = core.normalizeText(message.parentId);
  if (parentId && !config.categories.some((category) => category.id === parentId && category.enabled !== false)) {
    throw new Error("父分类不存在：" + parentId);
  }
  const id = core.categoryIdFromName(parentId, name, config.categories);
  const siblings = config.categories.filter((category) => (category.parentId || "") === (parentId || ""));
  const order = siblings.reduce((max, category) => Math.max(max, Number(category.order) || 0), 0) + 10;
  const categories = config.categories.concat([{ id, name, parentId: parentId || undefined, order, enabled: true }]);
  await chromeStorageSet({ categories });
  return Object.assign(await stateAfterCategoryAutoClassify(message), { addedCategory: { id, name, parentId: parentId || undefined, order, enabled: true } });
}

async function saveCategories(message) {
  const config = await getConfig();
  const requestedCategories = normalizeImportedCategories({ categories: message.categories }, {
    allowSmall: true,
    ensureFallback: false
  });
  const categories = requestedCategories;
  const previousIds = new Set(config.categories.filter((category) => category.enabled !== false).map((category) => category.id));
  const nextIds = new Set(categories.map((category) => category.id));
  const addedCategoryIds = categories.map((category) => category.id).filter((id) => !previousIds.has(id));
  const removedIds = new Set(Array.from(previousIds).filter((id) => !nextIds.has(id)));

  await chromeStorageSet({ categories });
  await cleanupDeletedCategoryReferences(removedIds, categories);
  const keywordResult = message.skipAutoClassify
    ? { checked: 0, matchedVideos: 0, addedAssignments: 0, skipped: true }
    : await appendKeywordCategories(addedCategoryIds, categories);
  return Object.assign(await getState(), {
    categorySaveResult: {
      addedCategoryIds,
      removedCategoryIds: Array.from(removedIds),
      keywordResult
    }
  });
}

async function appendKeywordCategories(categoryIds, categories) {
  const selectedCategoryIds = core.uniqueStrings(categoryIds);
  if (!selectedCategoryIds.length) {
    return { checked: 0, matchedVideos: 0, addedAssignments: 0 };
  }
  const summary = await db.summary();
  const classificationByBvid = new Map(summary.classifications.map((item) => [item.bvid, item]));
  let checked = 0;
  let matchedVideos = 0;
  let addedAssignments = 0;

  for (const video of summary.videos) {
    if (!video || video.presentInWatchlater === false) continue;
    const existing = classificationByBvid.get(video.bvid);
    checked += 1;
    const matchedIds = core.inferSelectedCategoryIds(video, categories, selectedCategoryIds);
    if (!matchedIds.length) continue;
    const existingIds = core.uniqueStrings(existing && existing.categoryIds);
    const nextIds = core.uniqueStrings(existingIds.concat(matchedIds));
    const addedCount = nextIds.length - existingIds.length;
    if (!addedCount) continue;
    const next = existing
      ? core.appendClassificationCategoryIds(existing, matchedIds)
      : core.mergeClassification(null, {
        bvid: video.bvid,
        categoryIds: nextIds,
        confidence: 0.68,
        reason: "新增分类的本地关键词追加判定",
        classifierVersion: core.LOCAL_CLASSIFIER_VERSION,
        manualOverride: false,
        sourceType: core.CLASSIFICATION_SOURCE_TYPES.KEYWORD
      }, video);
    await db.putClassification(next);
    matchedVideos += 1;
    addedAssignments += addedCount;
  }
  return { checked, matchedVideos, addedAssignments };
}

async function updateCategory(message) {
  const config = await getConfig();
  const id = core.normalizeText(message.id);
  if (!id) throw new Error("缺少分类 id");
  const categories = config.categories.map((category) => Object.assign({}, category));
  const category = categories.find((item) => item.id === id && item.enabled !== false);
  if (!category) throw new Error("分类不存在：" + id);

  const nextName = core.normalizeText(message.name);
  if (nextName) category.name = nextName;

  const nextParentId = core.normalizeText(message.parentId);
  if (nextParentId === id) throw new Error("分类不能设为自己的父分类");
  if (nextParentId && !categories.some((item) => item.id === nextParentId && item.enabled !== false)) {
    throw new Error("父分类不存在：" + nextParentId);
  }
  if (nextParentId && core.descendantsOf(id, categories).includes(nextParentId)) {
    throw new Error("不能移动到自己的子分类下面");
  }
  category.parentId = nextParentId || undefined;
  const siblings = categories.filter((item) => item.id !== id && (item.parentId || "") === (category.parentId || ""));
  category.order = siblings.reduce((max, item) => Math.max(max, Number(item.order) || 0), 0) + 10;

  await chromeStorageSet({ categories });
  return Object.assign(await stateAfterCategoryAutoClassify(message), { updatedCategory: category });
}

async function reorderCategory(message) {
  const config = await getConfig();
  const id = core.normalizeText(message.id);
  const targetId = core.normalizeText(message.targetId);
  if (!id || !targetId || id === targetId) throw new Error("缺少有效排序目标");
  const categories = config.categories.map((category) => Object.assign({}, category));
  const category = categories.find((item) => item.id === id && item.enabled !== false);
  const target = categories.find((item) => item.id === targetId && item.enabled !== false);
  if (!category || !target) throw new Error("分类不存在");
  if ((category.parentId || "") !== (target.parentId || "")) {
    throw new Error("只能在同一级分类内拖动排序；改变等级请用编辑分类目录");
  }

  const parentId = category.parentId || "";
  const siblings = categories
    .filter((item) => item.enabled !== false && (item.parentId || "") === parentId && item.id !== id)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  const targetIndex = Math.max(0, siblings.findIndex((item) => item.id === targetId));
  const insertIndex = message.position === "after" ? targetIndex + 1 : targetIndex;
  siblings.splice(insertIndex, 0, category);
  siblings.forEach((item, index) => {
    item.order = (index + 1) * 10;
  });

  await chromeStorageSet({ categories });
  return Object.assign(await getState(), { reorderedCategory: { id, targetId, position: message.position === "after" ? "after" : "before" } });
}

async function deleteCategory(message) {
  const config = await getConfig();
  const id = core.normalizeText(message.id);
  if (!id) throw new Error("缺少分类 id");
  if (!config.categories.some((category) => category.id === id && category.enabled !== false)) {
    throw new Error("分类不存在：" + id);
  }
  const removeIds = new Set(core.descendantsOf(id, config.categories));
  const proposedCategories = config.categories
    .filter((category) => category.enabled !== false && !removeIds.has(category.id))
    .map((category) => Object.assign({}, category));
  const classifications = await db.getAll("classifications");
  const categories = preserveManualCategoryDefinitions(proposedCategories, config.categories, classifications);
  const retainedIds = new Set(categories.map((category) => category.id));
  const deletedIds = new Set(Array.from(removeIds).filter((categoryId) => !retainedIds.has(categoryId)));
  await chromeStorageSet({ categories });
  await cleanupDeletedCategoryReferences(deletedIds, categories);
  return Object.assign(await stateAfterCategoryAutoClassify(message), { deletedCategoryIds: Array.from(deletedIds) });
}

async function stateAfterCategoryAutoClassify(options) {
  const config = await getConfig();
  const onboardingPending = config.settings.onboardingEligible === true && config.settings.onboardingCompleted !== true;
  if ((options && options.skipAutoClassify) || onboardingPending) {
    return Object.assign(await getState(), {
      autoClassifyResult: { classified: 0, skippedManual: 0, reclassifiedManual: 0, unchanged: 0, skipped: true }
    });
  }
  return autoClassify({ silent: true, includeAll: true });
}

async function cleanupDeletedCategoryReferences(removeIds, categories) {
  const validIds = new Set((categories || []).filter((category) => category.enabled !== false).map((category) => category.id));
  const classifications = await db.getAll("classifications");
  for (const classification of classifications) {
    const invalidIds = core.uniqueStrings(classification.categoryIds)
      .filter((id) => removeIds.has(id) || !validIds.has(id));
    const next = core.removeClassificationCategoryIds(
      classification,
      invalidIds,
      validIds.has("other.todo") ? "other.todo" : ""
    );
    if (next !== classification) await db.putClassification(next);
  }
}

function getClassifySummary(videos, classifications) {
  const counts = core.classificationStageCounts(videos, classifications);
  return {
    total: counts.total,
    pendingFineClassification: counts.pending,
    aiClassified: counts.ai,
    manualConfirmed: counts.manual
  };
}
