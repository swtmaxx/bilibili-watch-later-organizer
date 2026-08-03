(async function autoLlmClassify() {
  "use strict";

  const CONFIG = {
    // OpenAI-compatible endpoint format: chat_completions or responses.
    // Examples:
    // - https://api.openai.com/v1/chat/completions
    // - https://api.deepseek.com/chat/completions
    // - https://openrouter.ai/api/v1/chat/completions
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "chat_completions",
    // Paste a temporary key here only for local use. Never commit a real key.
    apiKey: "YOUR_API_KEY_HERE",
    model: "tencent/hy3:free",
    batchSize: 50,
    resetNonManual: true,
    includeAll: true,
    mergeMode: "replace",
    temperature: 0.1,
    maxRetries: 2,
    retryDelayMs: 1500,
    requestTimeoutMs: 120000,
    useResponseFormat: true
  };

  function send(payload) {
    return chrome.runtime.sendMessage(payload).then((response) => {
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "扩展后台无响应");
      }
      return response.data;
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseJsonObject(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("LLM 返回为空");
    const candidate = jsonCandidate(raw);
    try {
      return JSON.parse(candidate);
    } catch (firstError) {
      const repaired = repairLooseJson(candidate);
      try {
        return JSON.parse(repaired);
      } catch (repairError) {
        throw new Error("LLM 返回不是严格 JSON：" + repairError.message + "；片段：" + candidate.slice(0, 180));
      }
    }
  }

  function jsonCandidate(raw) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) return raw.slice(objectStart, objectEnd + 1);
    const arrayStart = raw.indexOf("[");
    const arrayEnd = raw.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) return raw.slice(arrayStart, arrayEnd + 1);
    return raw;
  }

  function repairLooseJson(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, "$1\"$2\"$3")
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, content) => JSON.stringify(content.replace(/\\"/g, "\"")))
      .replace(/,\s*([}\]])/g, "$1");
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function apiUrl(value, format) {
    const url = String(value || "").trim().replace(/\/+$/g, "");
    if (!url) return "";
    if (format === "responses") {
      if (/\/responses$/i.test(url)) return url;
      if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, "/responses");
      return url + "/responses";
    }
    if (/\/chat\/completions$/i.test(url)) return url;
    if (/\/responses$/i.test(url)) return url.replace(/\/responses$/i, "/chat/completions");
    return url + "/chat/completions";
  }

  function buildRequestBody(prompt) {
    if (CONFIG.apiFormat === "responses") {
      const body = {
        model: CONFIG.model,
        temperature: CONFIG.temperature,
        instructions: "你只返回严格 JSON。不要 Markdown，不要解释。",
        input: prompt
      };
      if (CONFIG.useResponseFormat) body.text = { format: { type: "json_object" } };
      return body;
    }

    const body = {
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      messages: [
        { role: "system", content: "你只返回严格 JSON。不要 Markdown，不要解释。" },
        { role: "user", content: prompt }
      ]
    };
    if (CONFIG.useResponseFormat) body.response_format = { type: "json_object" };
    return body;
  }

  function extractResponseText(payload) {
    const chatMessage = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
    if (chatMessage && typeof chatMessage.content === "string") return chatMessage.content.trim();
    if (payload && typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
    const output = payload && Array.isArray(payload.output) ? payload.output : [];
    return output.map((item) => {
      const content = item && item.content != null ? item.content : item;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) return content.map((part) => part && typeof part.text === "string" ? part.text.trim() : "").filter(Boolean).join("\n");
      return content && typeof content.text === "string" ? content.text.trim() : "";
    }).filter(Boolean).join("\n");
  }

  async function callLlm(prompt, attempt) {
    const response = await fetchWithTimeout(apiUrl(CONFIG.baseUrl, CONFIG.apiFormat), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + CONFIG.apiKey
      },
      body: JSON.stringify(buildRequestBody(prompt))
    }, CONFIG.requestTimeoutMs);

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error("LLM HTTP " + response.status + ": " + responseText.slice(0, 500));
    }

    const data = parseJsonObject(responseText);
    const content = extractResponseText(data);
    if (!content) {
      throw new Error("LLM 响应缺少可读取的文本内容，第 " + attempt + " 次尝试");
    }
    return parseJsonObject(content);
  }

  async function callLlmWithRetry(prompt) {
    let lastError = null;
    for (let attempt = 1; attempt <= CONFIG.maxRetries + 1; attempt += 1) {
      try {
        return await callLlm(prompt, attempt);
      } catch (error) {
        lastError = error;
        if (attempt > CONFIG.maxRetries) break;
        await sleep(CONFIG.retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  function assertUsablePayload(payload) {
    const items = Array.isArray(payload && payload.items)
      ? payload.items
      : Array.isArray(payload && payload.classifications)
        ? payload.classifications
        : [];
    if (!items.length) throw new Error("LLM JSON 没有 items/classifications 数组");
    return { items };
  }

  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
    throw new Error("请在 B站稍后再看分类库 dashboard.html 页面运行这个脚本");
  }
  if (!CONFIG.apiKey || CONFIG.apiKey === "YOUR_API_KEY_HERE") {
    throw new Error("请先在 scripts/auto-llm-classify.js 顶部填写 CONFIG.apiKey / model / baseUrl");
  }

  const progress = {
    config: Object.assign({}, CONFIG, { apiKey: CONFIG.apiKey ? "[redacted]" : "" }),
    startedAt: new Date().toISOString(),
    resetResult: null,
    totalCandidates: 0,
    offset: 0,
    batches: [],
    imported: 0,
    skipped: 0,
    warnings: [],
    done: false
  };
  globalThis.BiliWLAutoLlmClassify = progress;

  if (CONFIG.resetNonManual) {
    const resetState = await send({ type: "RESET_FOR_LLM_RECLASSIFY" });
    progress.resetResult = resetState.resetResult || {};
    console.info("[BiliWL] 已清除非手动分类 " + (progress.resetResult.removedClassifications || 0) + " 项，保留手动 " + (progress.resetResult.keptManual || 0) + " 项。");
  }

  while (true) {
    const exported = await send({
      type: "EXPORT_CLASSIFY_BATCH",
      includeAll: CONFIG.includeAll,
      limit: CONFIG.batchSize,
      offset: progress.offset
    });
    progress.totalCandidates = exported.totalCandidates || 0;
    if (!exported.batchSize) break;

    const batch = {
      index: progress.batches.length + 1,
      offset: exported.offset || progress.offset,
      size: exported.batchSize,
      totalCandidates: exported.totalCandidates || 0,
      status: "calling-llm"
    };
    progress.batches.push(batch);
    console.info("[BiliWL] 正在分类批次 " + batch.index + "，offset=" + batch.offset + "，size=" + batch.size + " / " + batch.totalCandidates);

    const prompt = [
      exported.prompt || "",
      "",
      "重要：必须为本批待分类视频中的每一个 bvid 返回一项。不要漏掉视频；信息不足时用 other.todo。",
      "返回必须是严格 JSON 对象：所有属性名和字符串都必须使用双引号，顶层必须是 {\"items\":[...]}。"
    ].join("\n");
    const payload = assertUsablePayload(await callLlmWithRetry(prompt));
    batch.status = "importing";
    batch.llmItems = payload.items.length;
    if (payload.items.length < batch.size) {
      batch.warnings = ["LLM 返回 " + payload.items.length + " 项，少于本批 " + batch.size + " 个视频"];
      console.warn("[BiliWL] " + batch.warnings[0]);
    }

    const importedState = await send({
      type: "IMPORT_CLASSIFICATIONS",
      payload: JSON.stringify(payload),
      options: { mergeMode: CONFIG.mergeMode }
    });
    const importResult = importedState.importResult || {};
    batch.status = "done";
    batch.imported = importResult.imported || 0;
    batch.skipped = importResult.skipped || 0;
    batch.warnings = (batch.warnings || []).concat(importResult.warnings || []);
    progress.imported += batch.imported;
    progress.skipped += batch.skipped;
    progress.warnings.push(...batch.warnings);
    progress.offset += CONFIG.includeAll ? (exported.batchSize || 0) : 0;
    if (!CONFIG.includeAll && !batch.imported) {
      throw new Error("当前批次没有导入任何结果；为避免重复处理同一批 keyword 视频，脚本已停止");
    }

    console.info("[BiliWL] 批次 " + batch.index + " 导入完成：imported=" + batch.imported + "，skipped=" + batch.skipped);
  }

  progress.done = true;
  progress.finishedAt = new Date().toISOString();
  console.info("[BiliWL] 自动 LLM 分类完成：导入 " + progress.imported + " 项，跳过 " + progress.skipped + " 项。详情见 window.BiliWLAutoLlmClassify。");
  return progress;
})();
