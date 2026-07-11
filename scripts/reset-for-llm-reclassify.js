(async function resetForLlmReclassify() {
  "use strict";

  const batchSize = 80;

  function send(payload) {
    return chrome.runtime.sendMessage(payload).then((response) => {
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "扩展后台无响应");
      }
      return response.data;
    });
  }

  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
    throw new Error("请在 B站稍后再看分类库 dashboard.html 页面运行这个脚本");
  }

  const resetState = await send({ type: "RESET_FOR_LLM_RECLASSIFY" });
  const resetResult = resetState.resetResult || {};
  const prompts = [];
  let offset = 0;
  let totalCandidates = 0;

  do {
    const result = await send({
      type: "EXPORT_CLASSIFY_BATCH",
      includeAll: true,
      limit: batchSize,
      offset
    });
    totalCandidates = result.totalCandidates || 0;
    if (!result.batchSize) break;
    prompts.push({
      index: prompts.length + 1,
      offset: result.offset || offset,
      batchSize: result.batchSize || 0,
      totalCandidates,
      prompt: result.prompt || ""
    });
    offset += result.batchSize || 0;
  } while (offset < totalCandidates);

  const bundleText = prompts.map((item) => [
    "===== LLM 全局重分类批次 " + item.index + " / " + prompts.length + " =====",
    "offset=" + item.offset + ", batchSize=" + item.batchSize + ", total=" + item.totalCandidates,
    "",
    item.prompt
  ].join("\n")).join("\n\n");

  const output = {
    resetResult,
    prompts,
    totalCandidates,
    copiedFirstPrompt: false,
    downloaded: false,
    copyPrompt(index) {
      const item = prompts[Math.max(0, Number(index || 1) - 1)];
      if (!item) throw new Error("没有这个批次：" + index);
      return navigator.clipboard.writeText(item.prompt);
    }
  };

  if (prompts[0] && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(prompts[0].prompt);
      output.copiedFirstPrompt = true;
    } catch (error) {
      output.clipboardError = error && error.message ? error.message : String(error);
    }
  }

  try {
    const blob = new Blob([bundleText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "bili-llm-reclassify-prompts.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    output.downloaded = true;
  } catch (error) {
    output.downloadError = error && error.message ? error.message : String(error);
  }

  globalThis.BiliWLResetForLlm = output;
  console.info("[BiliWL] 已清除非手动分类 " + (resetResult.removedClassifications || 0) + " 项，保留手动 " + (resetResult.keptManual || 0) + " 项，清空任务 " + (resetResult.clearedJobs || 0) + " 项。");
  console.info("[BiliWL] 已生成 " + prompts.length + " 个 LLM prompt 批次，共 " + totalCandidates + " 个非手动视频。结果保存在 window.BiliWLResetForLlm。");
  if (output.copiedFirstPrompt) console.info("[BiliWL] 第一批 prompt 已复制到剪贴板。");
  return output;
})();
