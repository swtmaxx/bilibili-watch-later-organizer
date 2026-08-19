(function attachDashboard() {
  "use strict";

  const core = globalThis.BiliWLCore;
  const message = core.MESSAGE_TYPES;
  const app = document.getElementById("app");

  let state = {
    videos: [],
    classifications: [],
    categories: [],
    settings: Object.assign({}, core.DEFAULT_SETTINGS),
    classifySummary: null,
    progress: null
  };
  let activeFilter = {
    categoryIds: [],
    includeUnclassified: false,
    includeRemoved: false,
    sourceCategoryId: "",
    upGroupKey: "",
    watchProgressPreset: core.WATCH_PROGRESS_FILTER_PRESETS.ALL,
    durationPreset: core.DURATION_FILTER_PRESETS.ALL,
    durationMin: "",
    durationMax: ""
  };
  let searchText = "";
  let selectedBvid = "";
  let categoryAdminOpen = false;
  let categoryDraft = null;
  let categoryDraftDirty = false;
  let savedCategoryScrollTop = 0;
  let draggedCategoryId = "";
  let dragDropPosition = "before";
  let suppressCategoryClick = false;
  let batchMode = false;
  let selectedBvids = new Set();
  let batchCategoryId = "";
  let favoriteFolderTitle = "";
  let favoriteRun = { running: false, result: null, message: "" };
  let bulkRemoveRun = { running: false, result: null, message: "", failed: false };
  let selectionBox = null;
  let suppressNextCardClick = false;
  let llmRun = { running: false, stopRequested: false, done: false, imported: 0, skipped: 0, processed: 0, total: 0, message: "" };
  let manualEditorOpen = false;
  let llmPanelOpen = false;
  let settingsPanelOpen = false;
  let apiSettingsOpen = false;
  let autoApiSettingsOpen = false;
  let apiSettingsDraft = null;
  let autoApiSettingsDraft = null;
  let apiTestState = { running: false, message: "" };
  let dataBackupState = { running: false, message: "" };
  let categoryGeneration = { running: false, message: "" };
  let syncAnimations = { added: new Set(), changed: new Set() };
  let syncAnimationTimer = 0;
  let idleDetailTimer = 0;
  let lastIdleDetailRefreshAt = 0;
  let onboardingCheckingLogin = false;
  let onboardingLoginStatus = "unknown";
  let onboardingPanelDismissed = false;
  let onboardingCategoryRunning = false;
  let onboardingCategoryMessage = "";
  let savedMainScrollTop = 0;
  let savedEditorScrollTop = 0;
  let statusNotice = { text: "", kind: "info" };
  let videoViewSaveQueue = Promise.resolve();
  let videoViewChangeId = 0;
  let categoryCollapseSaveQueue = Promise.resolve();
  let categoryCollapseChangeId = 0;
  const IDLE_DETAIL_DELAY_MS = 12000;
  const IDLE_DETAIL_INTERVAL_MS = 30 * 60 * 1000;

  init();

  function init() {
    app.addEventListener("click", onClick);
    app.addEventListener("input", onInput);
    app.addEventListener("change", onChange);
    app.addEventListener("dragstart", onDragStart);
    app.addEventListener("dragover", onDragOver);
    app.addEventListener("drop", onDrop);
    app.addEventListener("dragend", onDragEnd);
    app.addEventListener("pointerdown", onPointerDown);
    app.addEventListener("pointermove", onPointerMove);
    app.addEventListener("pointerup", onPointerUp);
    app.addEventListener("pointercancel", onPointerUp);
    app.addEventListener("scroll", onSelectionScroll, true);
    app.addEventListener("wheel", onWheel, { passive: false });
    chrome.runtime.onMessage.addListener((payload) => {
      if (payload && payload.type === message.JOB_PROGRESS) {
        state.progress = payload.progress;
        setStatus(payload.progress.message || "正在同步视频信息…");
      }
    });
    renderShell();
    bootstrap();
  }

  async function bootstrap() {
    onboardingCheckingLogin = true;
    await refreshState("正在读取已同步视频…");
    if (onboardingActive()) {
      await checkOnboardingLoginAndSync();
    } else {
      onboardingCheckingLogin = false;
      await syncOnOpen();
      await checkAutoLlmOnRefresh();
    }
  }

  async function checkOnboardingLoginAndSync() {
    onboardingCheckingLogin = true;
    onboardingLoginStatus = "unknown";
    renderShell();
    try {
      const result = await send({ type: message.CHECK_BILI_LOGIN });
      onboardingLoginStatus = result.loginStatus || "unknown";
      if (onboardingLoginStatus === "logged_out") {
        onboardingCheckingLogin = false;
        onboardingPanelDismissed = false;
        if (onboardingStage() !== "login") {
          await updateOnboardingSettings({ onboardingStage: "login" });
        } else {
          renderShell();
        }
        setStatus("检测到当前浏览器尚未登录 B站");
        return;
      }
      await syncOnOpen();
    } catch (error) {
      onboardingCheckingLogin = false;
      onboardingLoginStatus = "unknown";
      renderShell();
      setStatus("登录状态检测失败：" + error.message);
    }
  }

  async function refreshState(statusText) {
    if (statusText) setStatus(statusText);
    try {
      updateState(await send({ type: message.GET_STATE }));
      setStatus("已显示已同步视频");
    } catch (error) {
      setStatus("读取失败：" + error.message);
    }
  }

  async function syncOnOpen() {
    if (onboardingActive()) {
      onboardingCheckingLogin = true;
      renderShell();
    }
    setStatus(presentVideos().length ? "正在后台同步稍后再看..." : "正在打开时同步稍后再看...");
    try {
      const result = await send({ type: message.SYNC_ON_OPEN, skipAutoClassify: onboardingActive() });
      const output = result.openSyncResult || {};
      const scan = output.scanResult || {};
      const auto = output.autoClassifyResult || {};
      onboardingLoginStatus = output.loginStatus || "unknown";
      onboardingCheckingLogin = false;
      await updateStateWithSyncAnimation(result, scan);
      setStatus("已同步 " + (scan.scannedCount || 0) + " 个视频" + (auto.skipped ? "；分类目录确定前暂不分类视频" : "；完成初步分类 " + (auto.classified || 0) + " 个") + (output.apiError ? "；接口提示：" + output.apiError : ""));
      if (onboardingActive() && onboardingLoginStatus === "logged_out" && onboardingStage() !== "login") {
        onboardingPanelDismissed = false;
        await updateOnboardingSettings({ onboardingStage: "login" });
      } else if (onboardingActive() && onboardingLoginStatus === "logged_in" && onboardingStage() === "login") {
        setStatus("首次同步完成；正在更新缺失的视频详情...");
        await runDetails({ source: "onboarding" });
        onboardingPanelDismissed = false;
        await updateOnboardingSettings({ onboardingStage: "setup" });
      }
      if (onboardingLoginStatus !== "logged_out") scheduleIdleDetailRefresh();
    } catch (error) {
      onboardingCheckingLogin = false;
      onboardingLoginStatus = "unknown";
      setStatus("打开时同步失败：" + error.message + "。正在显示已同步视频…");
      await refreshState();
      scheduleIdleDetailRefresh();
    }
  }

  async function send(payload) {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "扩展后台无响应");
    }
    return response.data;
  }

  function updateState(nextState) {
    if (nextState && nextState.categories && !categoryDraftDirty) categoryDraft = null;
    state = Object.assign({}, state, nextState || {});
    if (selectedBvid && !presentVideos().some((video) => video.bvid === selectedBvid)) {
      selectedBvid = "";
    }
    if (!selectedBvid) {
      const first = visibleVideos()[0] || state.videos.find((video) => video.presentInWatchlater !== false);
      selectedBvid = first ? first.bvid : "";
    }
    renderShell();
  }

  function onboardingActive() {
    const settings = state.settings || {};
    return settings.onboardingEligible === true && settings.onboardingCompleted !== true;
  }

  function onboardingStage() {
    return core.normalizeText(state.settings && state.settings.onboardingStage) || "login";
  }

  async function updateOnboardingSettings(patch) {
    updateState(await send({
      type: message.UPDATE_SETTINGS,
      settings: Object.assign({ onboardingVersion: 1 }, patch || {})
    }));
  }

  async function updateStateWithSyncAnimation(nextState, scanResult) {
    const delta = syncDelta(scanResult);
    if (delta.removed.length) {
      delta.removed.forEach((bvid) => {
        const card = videoCardByBvid(bvid);
        if (card) card.classList.add("sync-removing");
      });
      await sleep(180);
    }
    syncAnimations = {
      added: new Set(delta.added),
      changed: new Set(delta.changed.filter((bvid) => !delta.added.includes(bvid)))
    };
    updateState(nextState);
    scheduleClearSyncAnimations();
  }

  function syncDelta(scanResult) {
    const result = scanResult || {};
    return {
      added: Array.isArray(result.newBvids) ? result.newBvids : [],
      changed: Array.isArray(result.changedBvids) ? result.changedBvids : [],
      removed: Array.isArray(result.removedBvids) ? result.removedBvids : []
    };
  }

  function scheduleClearSyncAnimations() {
    if (syncAnimationTimer) clearTimeout(syncAnimationTimer);
    syncAnimationTimer = setTimeout(() => {
      syncAnimations = { added: new Set(), changed: new Set() };
      document.querySelectorAll(".sync-added,.sync-updated").forEach((node) => {
        node.classList.remove("sync-added", "sync-updated");
      });
    }, 900);
  }

  function videoCardByBvid(bvid) {
    return Array.from(document.querySelectorAll(".video-card[data-bvid]"))
      .find((card) => card.dataset.bvid === bvid);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function renderShell() {
    rememberScrollPositions();
    const visible = visibleVideos();
    const children = [el("div", { className: "app" + (batchMode ? " batch-mode" : "") }, [
      renderSidebar(),
      renderMain(visible),
      renderEditor(visible)
    ])];
    const banner = renderOnboardingBanner();
    const overlay = renderOnboardingOverlay();
    if (banner) children.push(banner);
    if (overlay) children.push(overlay);
    app.replaceChildren(...children);
    restoreScrollPositions();
  }

  function renderOnboardingOverlay() {
    if (!onboardingActive() || onboardingPanelDismissed) return null;
    const stage = onboardingStage();
    let content;
    if (stage === "login") {
      const loggedOut = onboardingLoginStatus === "logged_out";
      const unknown = !onboardingCheckingLogin && onboardingLoginStatus === "unknown";
      content = [
        el("div", { className: "onboarding-kicker", textContent: "首次使用 · 1 / 3" }),
        el("h2", { textContent: onboardingCheckingLogin ? "正在检查 B站登录状态" : loggedOut ? "请先登录 B站" : unknown ? "暂时无法确认登录状态" : "正在准备整理助手" }),
        el("p", { textContent: onboardingCheckingLogin
          ? "插件正在读取你的稍后再看列表，通常只需要几秒。"
          : loggedOut
            ? "稍后再看列表需要使用你当前浏览器中的 B站登录状态。登录成功后回到这里重新检测。"
            : "网络或 B站接口暂时不可用。可以先打开 B站确认登录，再重新检测。" }),
        el("div", { className: "onboarding-actions" }, [
          el("a", { className: "onboarding-link primary", href: "https://www.bilibili.com/", target: "_blank", textContent: "打开 B站并登录" }),
          el("button", { className: "ghost", dataset: { action: "retry-onboarding-login" }, textContent: "我已登录，重新检测" })
        ])
      ];
    } else if (stage === "setup") {
      content = [
        el("div", { className: "onboarding-kicker", textContent: "首次使用 · 2 / 3" }),
        el("h2", { textContent: "先设置你的分类目录" }),
        el("p", { textContent: "这里调整的是所有视频共用的分类目录，不是在给视频分配类别。默认目录不一定适合你，可以手动修改，也可以让 AI 根据现有视频的标题、UP主、分区、标签、简介、分P标题和时长重新生成。" }),
        renderOnboardingCategoryPreview("当前分类目录"),
        el("div", { className: "onboarding-options" }, [
          onboardingOption("categories", "1", "我要手动设置我的分类", "收起引导卡片并展开右侧的编辑分类目录，直接修改可选分类。"),
          onboardingOption("api", "2", "我有 API，让 AI 帮我调整分类", "填写 API 后，AI 会根据现有视频的信息自动生成并替换分类目录。")
        ]),
        el("div", { className: "onboarding-note", textContent: "完成这一阶段后，第三步才会开始给每一个视频分配类别。" })
      ];
    } else if (stage === "setup-api") {
      const settings = state.settings || {};
      const configured = apiSettingsReady(settings);
      content = [
        el("div", { className: "onboarding-kicker", textContent: "首次使用 · 2 / 3 · API" }),
        el("h2", { textContent: "让 AI 生成分类目录" }),
        el("p", { textContent: "分类目录生成和 AI 批量视频分类共用同一组 API 设置。AI 会参考现有视频的标题、UP主、分区、标签、简介、分P标题和时长；生成目录本身不会给每个视频分类。" }),
        renderCategorySampleLimitSetting(),
        el("div", { className: "onboarding-api-state " + (configured ? "ready" : "missing"), textContent: configured ? "API 已设置，可以先测试，或直接生成分类目录。" : "API 尚未设置完整，请先到右侧“设置”中填写并测试。" }),
        onboardingCategoryMessage ? el("div", { className: "onboarding-run-status", textContent: onboardingCategoryMessage }) : null,
        el("div", { className: "onboarding-actions" }, [
          el("button", { className: "ghost", dataset: { action: "back-onboarding-setup" }, textContent: "← 返回上一步" }),
          el("button", { dataset: { action: "open-onboarding-api-settings" }, textContent: "设置API" }),
          configured ? el("button", { className: "primary", dataset: { action: "save-onboarding-api" }, textContent: onboardingCategoryRunning ? "AI 正在生成分类目录…" : "让 AI 生成分类目录" }) : null
        ])
      ].filter(Boolean);
    } else if (stage === "setup-result") {
      content = [
        el("div", { className: "onboarding-kicker", textContent: "首次使用 · 2 / 3 · 已更新" }),
        el("h2", { textContent: "新的分类目录已生成" }),
        el("p", { textContent: "下面是 AI 根据现有视频信息生成的新分类目录。它已经取代默认目录，并附带 keywords 供后续初步分类使用。还需要手动调整吗？" }),
        renderOnboardingCategoryPreview("新的分类目录"),
        el("div", { className: "onboarding-actions" }, [
          el("button", { className: "ghost", dataset: { action: "back-onboarding-method" }, textContent: "← 返回上一步" }),
          el("button", { dataset: { action: "adjust-onboarding-result" }, textContent: "需要，编辑分类目录" }),
          el("button", { className: "primary", dataset: { action: "show-onboarding-guide" }, textContent: "不需要，继续" })
        ])
      ];
    } else if (stage === "setup-categories") {
      content = [
        el("div", { className: "onboarding-kicker", textContent: "首次使用 · 2 / 3 · 手动" }),
        el("h2", { textContent: "编辑分类目录" }),
        el("p", { textContent: "编辑分类目录会在右侧栏展开。你可以增删、改名或调整父级，点击“确定保存”后再继续。" }),
        el("div", { className: "onboarding-actions" }, [
          el("button", { className: "ghost", dataset: { action: "back-onboarding-setup" }, textContent: "← 返回上一步" }),
          el("button", { dataset: { action: "reopen-onboarding-categories" }, textContent: "展开编辑分类目录" }),
          el("button", { className: "primary", dataset: { action: "show-onboarding-guide" }, textContent: "分类目录已调整，继续" })
        ])
      ];
    } else {
      content = [
        el("div", { className: "onboarding-kicker", textContent: "首次使用 · 3 / 3" }),
        el("h2", { textContent: "分类目录已确定，接下来给视频分类" }),
        el("p", { textContent: "下面才是把每个视频分配到刚才目录中的步骤。优先级从高到低如下；任选一种方式完成一次视频分类，引导就会结束。" }),
        el("div", { className: "onboarding-levels" }, [
          onboardingLevel("manual", "细分类 · 最高", "手动确认", "你亲自确认的分类具有最高优先级，不会被自动修改。"),
          onboardingLevel("llm", "细分类", "AI 分类", "使用 AI 进一步判断视频内容；结果过旧或不确定时可重新分类。"),
          onboardingLevel("keyword", "粗分类", "初步分类", "插件会先自动整理，速度快，但可能不够准确，仍会进入待精细分类。")
        ]),
        el("div", { className: "onboarding-actions onboarding-actions-wide" }, [
          el("button", { className: "primary", dataset: { action: "start-onboarding-classify", mode: "manual" }, textContent: "手动调整一个视频分类" }),
          el("button", { dataset: { action: "start-onboarding-classify", mode: "api" }, textContent: "启动 AI (API) 批量视频分类" })
        ]),
        el("button", { className: "onboarding-back", dataset: { action: "back-onboarding-setup" }, textContent: "← 返回上一步" }),
        el("button", { className: "onboarding-skip", dataset: { action: "complete-onboarding" }, textContent: "稍后再分类，结束引导" })
      ];
    }
    return el("div", { className: "onboarding-overlay" }, [
      el("section", { className: "onboarding-card", role: "dialog", "aria-modal": "true" }, content)
    ]);
  }

  function onboardingOption(method, number, titleValue, description) {
    return el("button", {
      className: "onboarding-option",
      dataset: { action: "choose-onboarding-method", method }
    }, [
      el("span", { className: "onboarding-number", textContent: number }),
      el("span", {}, [
        el("strong", { textContent: titleValue }),
        el("small", { textContent: description })
      ])
    ]);
  }

  function onboardingLevel(source, rank, titleValue, description) {
    return el("div", { className: "onboarding-level onboarding-level-" + source }, [
      el("span", { className: "onboarding-rank", textContent: rank }),
      el("div", {}, [el("strong", { textContent: titleValue }), el("small", { textContent: description })])
    ]);
  }

  function renderOnboardingCategoryPreview(titleValue) {
    const rows = flattenCategoriesInTree();
    return el("div", { className: "onboarding-category-preview" }, [
      el("strong", { textContent: titleValue + " · " + rows.length + " 项" }),
      el("div", {}, rows.map(({ category, level }) => el("span", {
        className: "onboarding-category-level-" + Math.min(level, 2),
        textContent: (level ? "└ ".padStart(level * 2 + 2, "　") : "") + category.name
      })))
    ]);
  }

  function renderOnboardingBanner() {
    if (!onboardingActive() || !onboardingPanelDismissed) return null;
    const stage = onboardingStage();
    let titleValue = "完成首次设置";
    let description = "调整完成后，继续了解分类等级。";
    if (stage === "setup-categories") {
      titleValue = "正在编辑分类目录";
      description = "在右侧编辑分类目录中调整草稿，并点击“确定保存”。";
    } else if (stage === "setup-api") {
      titleValue = "正在设置 API";
      description = "在右侧设置中保存并测试 API，然后返回首次引导。";
    } else if (stage === "classify") {
      titleValue = "完成一次首次分类";
      description = "保存手动确认、导入 JSON 或完成 AI 视频分类后，引导会自动结束。";
    }
    return el("div", { className: "onboarding-banner" }, [
      el("div", {}, [el("strong", { textContent: titleValue }), el("span", { textContent: description })]),
      el("div", { className: "onboarding-banner-actions" }, stage === "setup-categories" ? [
        el("button", { className: "ghost", dataset: { action: "back-onboarding-setup" }, textContent: "返回上一步" }),
        el("button", { className: "primary", dataset: { action: "show-onboarding-guide" }, textContent: "调整好了，继续" })
      ] : stage === "setup-api" ? [
        el("button", { className: "primary", dataset: { action: "resume-onboarding-api" }, textContent: "返回首次引导" })
      ] : [
        el("button", { className: "ghost", dataset: { action: "back-onboarding-guide" }, textContent: "返回上一步" }),
        el("button", { className: "ghost", dataset: { action: "complete-onboarding" }, textContent: "稍后处理" })
      ])
    ]);
  }

  function renderSidebar() {
    return el("aside", { className: "sidebar" }, [
      el("div", { className: "side-head" }, [
        el("h1", { textContent: "稍后再看整理助手" }),
        el("div", { className: "sub", textContent: "自动归类，快速找到想看的视频" }),
        renderBrowseModeSwitch()
      ]),
      browseMode() === core.BROWSE_MODES.UP ? renderUpTree() : renderCategoryTree()
    ]);
  }

  function renderBrowseModeSwitch() {
    const current = browseMode();
    return el("div", { className: "browse-mode-switch", role: "group", "aria-label": "浏览模式" }, [
      el("button", {
        className: "browse-mode-button" + (current === core.BROWSE_MODES.CATEGORIES ? " active" : ""),
        type: "button",
        "aria-pressed": current === core.BROWSE_MODES.CATEGORIES,
        dataset: { action: "set-browse-mode", mode: core.BROWSE_MODES.CATEGORIES },
        textContent: "按分类目录"
      }),
      el("button", {
        className: "browse-mode-button" + (current === core.BROWSE_MODES.UP ? " active" : ""),
        type: "button",
        "aria-pressed": current === core.BROWSE_MODES.UP,
        dataset: { action: "set-browse-mode", mode: core.BROWSE_MODES.UP },
        textContent: "按 UP 主"
      })
    ]);
  }

  function browseMode() {
    return core.normalizeBrowseMode(state.settings && state.settings.browseMode);
  }

  function videoViewMode() {
    return core.normalizeVideoViewMode(state.settings && state.settings.videoViewMode);
  }

  function renderStats() {
    const summary = state.classifySummary || {};
    const counts = summary.total == null
      ? core.classificationStageCounts(state.videos, state.classifications)
      : {
        total: summary.total,
        pending: summary.pendingFineClassification,
        ai: summary.aiClassified,
        manual: summary.manualConfirmed
      };
    return el("div", { className: "stats" }, [
      statNode(counts.total || 0, "全部视频"),
      statNode(counts.pending || 0, "待精细分类"),
      statNode(counts.ai || 0, "AI 已分类"),
      statNode(counts.manual || 0, "手动确认")
    ]);
  }

  function renderEditorHeader() {
    const textValue = statusText();
    const kind = statusKind(textValue);
    return el("div", { className: "editor-sticky-header" }, [
      renderStats(),
      el("section", {
        className: "activity-status status-" + kind,
        dataset: { role: "status-surface" },
        role: "status",
        "aria-live": "polite"
      }, [
        el("span", { className: "activity-status-icon", dataset: { role: "status-icon" } }, [statusIcon(kind)]),
        el("div", { className: "activity-status-copy" }, [
          el("strong", { textContent: "操作反馈" }),
          el("span", { dataset: { role: "status" }, textContent: textValue })
        ])
      ])
    ]);
  }

  function statNode(value, label) {
    return el("div", { className: "stat" }, [
      el("strong", { textContent: String(value) }),
      el("span", { textContent: label })
    ]);
  }

  function renderCategoryTree() {
    const counts = categoryCounts();
    const fragment = document.createDocumentFragment();
    fragment.appendChild(el("button", {
      className: "cat-row" + (!activeFilter.categoryIds.length && !activeFilter.includeUnclassified && !activeFilter.upGroupKey ? " active" : ""),
      dataset: { action: "filter-all" }
    }, [
      el("span", { className: "cat-name", textContent: "全部视频" }),
      el("span", { className: "cat-count", textContent: String(presentVideos().length) })
    ]));
    fragment.appendChild(el("button", {
      className: "cat-row" + (activeFilter.includeUnclassified ? " active" : ""),
      dataset: { action: "filter-unclassified" }
    }, [
      el("span", { className: "cat-name", textContent: "待精细分类" }),
      el("span", { className: "cat-count", textContent: String(counts.unclassified) })
    ]));
    appendCategoryLevel(fragment, "", 0, counts);
    return el("nav", { className: "cat-nav" }, [fragment]);
  }

  function renderUpTree() {
    const groups = core.upGroups(presentVideos());
    const counts = categoryCounts();
    const fragment = document.createDocumentFragment();
    fragment.appendChild(el("button", {
      className: "cat-row" + (!activeFilter.categoryIds.length && !activeFilter.includeUnclassified && !activeFilter.upGroupKey ? " active" : ""),
      dataset: { action: "filter-all" }
    }, [
      el("span", { className: "cat-name", textContent: "全部视频" }),
      el("span", { className: "cat-count", textContent: String(presentVideos().length) })
    ]));
    fragment.appendChild(el("button", {
      className: "cat-row" + (activeFilter.includeUnclassified ? " active" : ""),
      dataset: { action: "filter-unclassified" }
    }, [
      el("span", { className: "cat-name", textContent: "待精细分类" }),
      el("span", { className: "cat-count", textContent: String(counts.unclassified) })
    ]));
    groups.forEach((group) => {
      fragment.appendChild(el("button", {
        className: "cat-row up-group-row" + (activeFilter.upGroupKey === group.key ? " active" : ""),
        dataset: { action: "filter-up", upGroupKey: group.key }
      }, [
        el("span", { className: "cat-name", textContent: group.name }),
        el("span", { className: "cat-count", textContent: String(group.count) })
      ]));
    });
    return el("nav", { className: "cat-nav up-nav" }, [fragment]);
  }

  function appendCategoryLevel(fragment, parentId, level, counts) {
    core.childrenOf(state.categories, parentId).forEach((category) => {
      const children = core.childrenOf(state.categories, category.id);
      const canCollapse = level === 0 && children.length > 0;
      const collapsed = canCollapse && isCategoryCollapsed(category.id);
      const expanded = expandCategoryIds([category.id]);
      const active = activeFilter.sourceCategoryId === category.id || expanded.length && expanded.every((id) => activeFilter.categoryIds.includes(id));
      const group = el("div", {
        className: "category-tree-group",
        draggable: true,
        title: "拖动可调整同级顺序；此分类及全部子分类会一起移动",
        dataset: { categoryGroup: category.id }
      }, [
        el("div", {
          className: "category-row-layout indent-" + Math.min(level, 3) + (canCollapse ? " has-collapse-toggle" : "")
        }, [
          el("button", {
            className: "cat-row category-draggable" + (active ? " active" : ""),
            type: "button",
            style: categoryStyle(category, "row"),
            dataset: { action: "filter-category", categoryId: category.id }
          }, [
            el("span", { className: "category-drag-handle", title: "拖动分类及其子分类", "aria-hidden": "true", textContent: "⋮⋮" }),
            el("span", { className: "cat-name", textContent: category.name }),
            el("span", { className: "cat-count", textContent: String(counts.byCategory.get(category.id) || 0) })
          ]),
          canCollapse ? el("button", {
            className: "category-collapse-toggle" + (collapsed ? " is-collapsed" : ""),
            type: "button",
            draggable: false,
            style: categoryStyle(category, "row"),
            title: (collapsed ? "展开" : "折叠") + "“" + category.name + "”的子分类",
            "aria-label": (collapsed ? "展开" : "折叠") + "“" + category.name + "”的子分类",
            "aria-expanded": !collapsed,
            dataset: { action: "toggle-category-collapse", categoryId: category.id }
          }, [iconNode(collapsed ? "chevron-right" : "chevron-down")]) : null
        ])
      ]);
      if (!collapsed) appendCategoryLevel(group, category.id, level + 1, counts);
      fragment.appendChild(group);
    });
  }

  function renderCategoryAdmin() {
    const draft = ensureCategoryDraft();
    const categoryRows = flattenCategoriesInTree(draft);
    const parentOptions = [el("option", { value: "", textContent: "一级分类" })]
      .concat(categoryRows.map(({ category, level }) => el("option", {
        value: category.id,
        textContent: categoryTreeLabel(category, level)
      })));
    return el("section", { className: "fold", dataset: { fold: "category-admin" } }, [
      el("button", { className: "fold-head", dataset: { action: "toggle-category-admin" } }, [
        el("h2", { textContent: "编辑分类目录" }),
        el("span", { dataset: { role: "fold-icon" }, textContent: categoryAdminOpen ? "⌃" : "⌄" })
      ]),
      el("div", { className: "fold-body" + (categoryAdminOpen ? "" : " hidden") }, [
        renderCategoryGenerationTools(),
        el("div", { className: "category-form" }, [
          el("select", { dataset: { role: "new-category-parent" } }, parentOptions),
          el("input", { type: "text", placeholder: "新分类名", dataset: { role: "new-category-name" } }),
          el("button", { dataset: { action: "add-category" }, textContent: "添加分类" })
        ]),
        el("div", { className: "sub", textContent: "这里的新增、改名、移动和删除都是草稿，点击“确定保存”后才会生效。" }),
        el("div", { className: "category-admin-list" }, categoryRows.map(({ category, level }) => renderCategoryAdminRow(category, level, draft))),
        el("div", { className: "refresh-actions" }, [
          el("button", { className: "primary", dataset: { action: "save-category-draft" }, textContent: "确定保存" }),
          el("button", { className: "ghost", dataset: { action: "discard-category-draft" }, textContent: "放弃未保存修改" }),
          categoryDraftDirty ? el("span", { className: "sub", textContent: "有未保存修改" }) : null
        ].filter(Boolean))
      ].filter(Boolean))
    ]);
  }

  function renderCategoryGenerationTools() {
    return el("div", { className: "category-generation" }, [
      el("div", { className: "category-generation-heading" }, [
        el("h3", { textContent: "让 AI 生成分类目录" }),
        el("p", { textContent: "AI 会参考现有视频的标题、UP主、分区、标签、简介、分P标题和时长，设计并替换可选分类目录；不会给已有视频重新分类，也不会覆盖手动确认。" })
      ]),
      renderCategorySampleLimitSetting(),
      el("div", { className: "category-generation-actions" }, [
        el("button", {
          className: "primary",
          dataset: { action: "generate-categories-api" },
          textContent: categoryGeneration.running ? "AI 正在生成…" : "使用 API 生成"
        }),
        el("button", { className: "ghost", dataset: { action: "open-api-settings" }, textContent: "设置API" })
      ]),
      categoryGeneration.message ? el("div", { className: "category-generation-status", textContent: categoryGeneration.message }) : null
    ].filter(Boolean));
  }

  function renderCategorySampleLimitSetting() {
    const settings = state.settings || {};
    return el("label", { className: "field category-sample-setting" }, [
      el("span", { textContent: "分类目录样本数量" }),
      el("input", {
        type: "number",
        min: "1",
        step: "1",
        value: settings.categorySampleLimit == null ? core.DEFAULT_SETTINGS.categorySampleLimit : settings.categorySampleLimit,
        placeholder: "60",
        dataset: { role: "category-sample-limit" }
      })
    ]);
  }

  function renderMain(visible) {
    return el("main", { className: "main" }, [
      el("div", { className: "topbar" }, [
        el("input", { className: "search-input", type: "search", value: searchText, placeholder: "搜索标题、UP主、分区、标签、BV号", dataset: { role: "search" } }),
        el("div", { className: "toolbar" }, [
          renderWatchProgressFilter(),
          renderDurationFilter(),
          el("select", { title: "排序", dataset: { role: "sort-combo" } }, sortOptions()),
          el("button", { className: "primary", title: "先同步列表，再排队更新缺失详情", dataset: { action: "sync-refresh" }, textContent: "同步并更新" }),
          toolbarIconButton("open-bili-home", "B站主页", "bilibili"),
          toolbarIconButton("open-watchlater", "稍后再看", "watchlater"),
          toolbarIconButton("open-bili-dynamic", "B站动态", "dynamic")
        ]),
        batchMode ? renderBatchPanel() : null,
        batchMode ? renderFavoriteFolderPanel() : null
      ]),
      renderContent(visible)
    ]);
  }

  function renderContent(visible) {
    return el("div", { className: "content", dataset: { role: "content" } }, [
      renderBatchSelectionBox(),
      el("div", { className: "list-head" }, [
        el("div", { className: "list-head-copy" }, [
          el("span", { textContent: "当前显示 " + visible.length + " / " + presentVideos().length + " 个" }),
          el("span", { textContent: activeFilterLabel() })
        ]),
        renderViewSwitch()
      ]),
      visible.length
        ? el("div", { className: "grid video-grid view-" + videoViewMode() }, visible.map(renderVideoCard))
        : el("div", { className: "empty", textContent: "没有匹配的视频。可以清除筛选或先在 B站页面扫描同步。" })
    ]);
  }

  function renderViewSwitch() {
    const current = videoViewMode();
    return el("div", { className: "view-switch", role: "group", "aria-label": "视频视图" }, [
      viewSwitchButton(core.VIDEO_VIEW_MODES.CARDS, current === core.VIDEO_VIEW_MODES.CARDS, "卡片视图", "grid"),
      viewSwitchButton(core.VIDEO_VIEW_MODES.LIST, current === core.VIDEO_VIEW_MODES.LIST, "列表视图", "list")
    ]);
  }

  function viewSwitchButton(mode, active, label, icon) {
    return el("button", {
      className: "view-switch-button" + (active ? " active" : ""),
      type: "button",
      title: label,
      "aria-label": label,
      "aria-pressed": active,
      dataset: { action: "set-video-view", mode }
    }, [
      iconNode(icon),
      el("span", { textContent: label.replace("视图", "") })
    ]);
  }

  function renderVideoCard(video) {
    const classification = classificationMap().get(video.bvid);
    const status = core.classifyStatus(video, classification);
    const sourceType = core.classificationSourceType(classification);
    return el("article", {
      className: "video-card" +
        (video.bvid === selectedBvid && !batchMode ? " selected" : "") +
        (batchMode ? " batch-pickable" : "") +
        (selectedBvids.has(video.bvid) ? " batch-selected" : "") +
        (syncAnimations.added.has(video.bvid) ? " sync-added" : "") +
        (syncAnimations.changed.has(video.bvid) ? " sync-updated" : ""),
      dataset: { action: "select-video", bvid: video.bvid }
    }, [
      batchMode ? el("div", { className: "select-mark", textContent: selectedBvids.has(video.bvid) ? "✓" : "" }) : null,
      batchMode ? renderCover(video) : el("a", {
        className: "cover-link",
        href: core.standardVideoUrl(video),
        target: "_blank",
        rel: "noopener noreferrer",
        title: "打开普通 B站视频页",
        "aria-label": "打开视频：" + (video.title || video.bvid)
      }, [renderCover(video)]),
      el("div", { className: "card-body" }, [
        el("div", { className: "title", textContent: video.title || video.bvid }),
        el("div", { className: "meta", textContent: [video.upName, video.tname].filter(Boolean).join(" · ") || video.bvid }),
        el("div", { className: "meta", textContent: [formatDate(video.pubdate), formatWatchlaterDate(video.watchlaterAddedAt)].filter(Boolean).join(" · ") }),
        renderMetricStats(video),
        el("div", { className: "badges" }, [
          ...(sourceType && sourceType !== core.CLASSIFICATION_SOURCE_TYPES.LLM
            ? [el("span", { className: "badge source source-" + sourceType, textContent: sourceLabel(sourceType) })]
            : []),
          ...(["unclassified", "stale", "low_confidence"].includes(status) ? [el("span", { className: "badge warn", textContent: statusLabel(status) })] : []),
          ...(categoryBadgeNodes(classification).length ? categoryBadgeNodes(classification) : [el("span", { className: "badge warn", textContent: "分类异常" })]).slice(0, 4)
        ]),
        el("div", { className: "card-actions" }, [
          el("a", { href: core.watchlaterPlaybackUrl(video), target: "_blank", rel: "noopener noreferrer", textContent: "稍后合集中打开" }),
          el("button", {
            className: "danger remove-icon",
            title: "移出稍后再看",
            "aria-label": "移出稍后再看",
            dataset: { action: "remove-watchlater", bvid: video.bvid }
          }, [iconNode("trash")])
        ])
      ])
    ].filter(Boolean));
  }

  function renderBatchPanel() {
    if (!batchMode) return el("div", { className: "batch-panel hidden" });
    const categoryRows = flattenCategoriesInTree();
    const selectedCategory = categoryRows.find(({ category }) => category.id === batchCategoryId) || categoryRows[0];
    if (selectedCategory) batchCategoryId = selectedCategory.category.id;
    const batchOperationRunning = favoriteRun.running || bulkRemoveRun.running;
    return el("section", { className: "batch-panel" }, [
      el("div", { className: "batch-panel-summary" }, [
        el("div", {}, [
          el("h3", { textContent: "批量管理" }),
          el("div", {
            className: "batch-count",
            dataset: { role: "batch-panel-count" },
            textContent: batchPanelCountText()
          })
        ]),
        el("div", { className: "batch-actions" }, [
          el("button", { dataset: { action: "batch-select-all" }, textContent: "全选当前结果" }),
          el("button", { className: "ghost", dataset: { action: "batch-clear-selection" }, textContent: "清空选择" }),
          el("button", {
            className: "danger batch-remove-watchlater",
            type: "button",
            disabled: batchOperationRunning || !selectedBvids.size,
            title: "将选中视频从 B站稍后再看移出，但保留本地分类记录",
            dataset: { action: "bulk-remove-watchlater" },
            textContent: bulkRemoveRun.running ? "正在批量移出…" : "批量移出稍后再看"
          })
        ])
      ]),
      el("div", { className: "batch-form" }, [
        el("div", { className: "batch-category-picker" }, [
          selectedCategory ? el("span", {
            className: "swatch batch-category-swatch",
            style: categoryStyle(selectedCategory.category, "swatch"),
            dataset: { role: "batch-category-swatch" }
          }) : null,
          el("select", { dataset: { role: "batch-category" }, title: "选择要添加的分类" }, categoryRows.map(({ category, level }) => {
            const prefix = level ? "　".repeat(level) + "└ " : "";
            return el("option", {
              value: category.id,
              selected: category.id === batchCategoryId,
              style: categoryStyle(category, "option"),
              textContent: "● " + prefix + category.name
            });
          }))
        ]),
        el("button", { className: "primary", dataset: { action: "batch-add-category" }, textContent: "添加分类到选中视频" }),
        el("button", { className: "danger", dataset: { action: "batch-clear-categories" }, textContent: "清除选中视频中所有现有分类" })
      ]),
      bulkRemoveRun.message
        ? el("div", {
          className: "batch-remove-result" + (bulkRemoveRun.failed || bulkRemoveRun.result && bulkRemoveRun.result.failed ? " has-failures" : ""),
          role: "status",
          "aria-live": "polite",
          textContent: bulkRemoveRun.message
        })
        : null
    ].filter(Boolean));
  }

  function renderFavoriteFolderPanel() {
    if (!batchMode) return el("div", { className: "favorite-panel hidden" });
    const hasTitle = Boolean(core.normalizeText(favoriteFolderTitle));
    const canSubmit = !favoriteRun.running && selectedBvids.size > 0 && hasTitle;
    return el("section", { className: "favorite-panel" }, [
      el("div", { className: "favorite-panel-summary" }, [
        el("div", {}, [
          el("h3", { textContent: "新建收藏夹" }),
          el("div", {
            className: "batch-count",
            dataset: { role: "favorite-panel-count" },
            textContent: "当前选择 " + selectedBvids.size + " 个视频"
          })
        ]),
        el("span", { className: "favorite-privacy", textContent: "默认私密" })
      ]),
      el("div", { className: "favorite-form" }, [
        el("label", { className: "field" }, [
          el("span", { textContent: "收藏夹名称" }),
          el("input", {
            type: "text",
            value: favoriteFolderTitle,
            maxlength: "50",
            placeholder: "例如：待看课程",
            dataset: { role: "favorite-folder-title" }
          })
        ]),
        el("button", {
          className: "primary",
          type: "button",
          disabled: !canSubmit,
          dataset: { action: "create-favorite-folder" },
          textContent: favoriteRun.running ? "正在创建并加入…" : "新建收藏夹并加入"
        })
      ]),
      el("div", {
        className: "favorite-note",
        textContent: "将当前选择的视频加入新建的 B站私密收藏夹；缺少视频编号或接口失败的项目会在完成后汇总。"
      }),
      favoriteRun.message
        ? el("div", {
          className: "favorite-result" + (favoriteRun.result && favoriteRun.result.failed ? " has-failures" : ""),
          textContent: favoriteRun.message
        })
        : null
    ].filter(Boolean));
  }

  function renderBatchSelectionBox() {
    if (!selectionBox) return el("div", { className: "selection-box hidden" });
    const left = Math.min(selectionBox.startX, selectionBox.currentX);
    const top = Math.min(selectionBox.startY, selectionBox.currentY);
    const width = Math.abs(selectionBox.currentX - selectionBox.startX);
    const height = Math.abs(selectionBox.currentY - selectionBox.startY);
    return el("div", {
      className: "selection-box",
      style: "left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;"
    });
  }

  function renderEditor(visible) {
    if (batchMode) {
      return renderBatchEditor();
    }
    const video = state.videos.find((item) => item.bvid === selectedBvid) || null;
    const classification = video ? classificationMap().get(video.bvid) : null;
    const selectedIds = new Set(classification && classification.categoryIds || []);
    return el("aside", { className: "editor" }, [
      renderEditorHeader(),
      el("div", { className: "editor-body" }, [
        renderManualEditor(video, selectedIds),
        renderLlmAutomation(),
        renderCategoryAdmin(),
        renderApiSettings()
      ])
    ]);
  }

  function renderBatchEditor() {
    return el("aside", { className: "editor batch-editor" }, [
      renderEditorHeader(),
      el("div", { className: "editor-body" }, [
        el("section", { className: "batch-editor-card" }, [
          el("div", { className: "batch-editor-heading" }, [
            el("h2", { textContent: "正在批量管理" }),
            el("strong", {
              dataset: { role: "batch-editor-count" },
              textContent: batchEditorCountText()
            })
          ]),
          el("div", { className: "batch-editor-note", textContent: "单个视频的手动调整已暂停。请在中间列表选择视频，并使用顶部固定操作区调整分类。" }),
          el("div", { className: "batch-editor-actions" }, [
            el("button", { className: "primary", dataset: { action: "toggle-batch" }, textContent: "退出批量管理" }),
            el("button", { className: "ghost", dataset: { action: "batch-clear-selection" }, textContent: "清空选择" })
          ])
        ]),
        renderLlmAutomation(),
        renderCategoryAdmin(),
        renderApiSettings()
      ])
    ]);
  }

  function renderManualEditor(video, selectedIds) {
    return el("section", { className: "fold", dataset: { fold: "manual-editor" } }, [
      el("button", { className: "fold-head", dataset: { action: "toggle-manual-editor" } }, [
        el("h2", { textContent: "手动调整视频分类" }),
        el("span", { dataset: { role: "fold-icon" }, textContent: manualEditorOpen ? "⌃" : "⌄" })
      ]),
      el("div", { className: "fold-body" + (manualEditorOpen ? "" : " hidden") }, video ? [
        el("div", { className: "sub section-note", textContent: "手动确认具有最高优先级，不会被初步分类或 AI 分类覆盖" }),
        el("div", { className: "preview manual-preview" }, [
          renderCover(video),
          el("div", {}, [
            el("div", { className: "preview-title", textContent: video.title || video.bvid }),
            el("div", { className: "preview-meta", textContent: [video.upName, video.tname, video.bvid, formatDate(video.pubdate)].filter(Boolean).join(" · ") })
          ])
        ]),
        el("div", { className: "check-list manual-category-list" }, flattenCategoriesInTree()
          .map(({ category, level }) => el("label", {
            className: "manual-cat-row manual-indent-" + Math.min(level, 4)
          }, [
            el("input", {
              type: "checkbox",
              value: category.id,
              checked: selectedIds.has(category.id),
              dataset: { role: "manual-category" }
            }),
            el("span", { className: "swatch", style: categoryStyle(category, "swatch") }),
            el("span", { textContent: category.name })
          ]))),
        el("div", { className: "editor-actions" }, [
          el("button", { className: "primary", dataset: { action: "save-manual", bvid: video.bvid }, textContent: "保存为手动确认" }),
          el("button", { className: "ghost", dataset: { action: "filter-unclassified" }, textContent: "查看待精细分类" }),
          el("button", { className: batchMode ? "primary" : "ghost", dataset: { action: "toggle-batch" }, textContent: batchMode ? "退出批量" : "批量管理" })
        ])
      ] : presentVideos().length ? [
        el("div", { className: "manual-editor-default" }, [
          el("div", { className: "manual-editor-default-icon", textContent: "✓" }),
          el("h3", { textContent: "选择一种调整方式" }),
          el("p", { textContent: "点击中间的视频卡片可单独调整分类，或进入批量管理一次处理多个视频。" }),
          el("button", { className: "primary", dataset: { action: "toggle-batch" }, textContent: "批量管理" })
        ])
      ] : [
        el("div", { className: "empty", textContent: "还没有已同步视频。请先点击“同步并更新”。" })
      ])
    ]);
  }

  function renderLlmAutomation() {
    const settings = state.settings || {};
    return el("section", { className: "fold llm-panel", dataset: { fold: "llm-panel" } }, [
      el("button", { className: "fold-head", dataset: { action: "toggle-llm-panel" } }, [
        el("h2", { textContent: "AI 批量视频分类" }),
        el("span", { dataset: { role: "fold-icon" }, textContent: llmPanelOpen ? "⌃" : "⌄" })
      ]),
      el("div", { className: "fold-body" + (llmPanelOpen ? "" : " hidden") }, [
        el("section", { className: "ai-method" }, [
          el("div", { className: "ai-method-heading" }, [
            el("h3", { textContent: "使用 API 自动分类" }),
            el("p", { textContent: apiSettingsReady(settings) ? "使用设置中已保存的 API；手动确认的视频始终跳过。" : "API 尚未设置完整，请先到“设置”中填写并测试。" })
          ]),
        el("div", { className: "llm-grid" }, [
          labeledInput("每批数量", "llm-batch-size", settings.llmBatchSize || 50, "50", "number"),
          labeledInput("本次数量", "llm-limit", settings.llmLimit || 0, "0 表示全部", "number")
        ]),
        el("label", { className: "inline-check" }, [
          el("input", { type: "checkbox", checked: settings.llmIncludeAll === true, dataset: { role: "llm-include-all" } }),
          text("重新处理已有 AI 分类")
        ]),
        el("div", { className: "llm-actions" }, [
          el("button", { className: "ghost", dataset: { action: "open-api-settings" }, textContent: "设置API" }),
          llmRun.running
            ? el("button", { className: "danger", dataset: { action: "stop-llm-run" }, textContent: "停止" })
            : el("button", { className: "primary", dataset: { action: "start-llm-run" }, textContent: "使用 API 开始分类" })
        ]),
        el("div", { className: "llm-progress" }, [
          el("div", { textContent: llmRun.message || "未运行" }),
          el("div", { textContent: "处理 " + (llmRun.processed || 0) + " / " + (llmRun.total || 0) + "，导入 " + (llmRun.imported || 0) + "，跳过 " + (llmRun.skipped || 0) + "，失败批次 " + failedBatchCount() }),
          llmRun.warnings && llmRun.warnings.length ? el("div", { textContent: "最近：" + llmRun.warnings[llmRun.warnings.length - 1] }) : null
        ].filter(Boolean))
        ])
      ])
    ]);
  }

  function renderDurationFilter() {
    const current = core.normalizeDurationFilterPreset(activeFilter.durationPreset);
    const custom = current === core.DURATION_FILTER_PRESETS.CUSTOM;
    return el("div", { className: "duration-filter", title: "按视频时长筛选" }, [
      el("span", { className: "duration-filter-label", textContent: "视频时长" }),
      el("select", { title: "视频时长筛选", dataset: { role: "duration-preset" } }, durationFilterOptions(current)),
      custom ? el("div", { className: "duration-range" }, [
        el("input", {
          type: "number",
          min: "0",
          step: "0.1",
          value: activeFilter.durationMin,
          placeholder: "最短分钟",
          title: "最短时长（分钟）",
          "aria-label": "最短时长（分钟）",
          dataset: { role: "duration-min" }
        }),
        el("span", { textContent: "至" }),
        el("input", {
          type: "number",
          min: "0",
          step: "0.1",
          value: activeFilter.durationMax,
          placeholder: "最长分钟",
          title: "最长时长（分钟）",
          "aria-label": "最长时长（分钟）",
          dataset: { role: "duration-max" }
        })
      ]) : null
    ].filter(Boolean));
  }

  function renderWatchProgressFilter() {
    const current = core.normalizeWatchProgressFilterPreset(activeFilter.watchProgressPreset);
    return el("div", { className: "watch-progress-filter", title: "按观看进度筛选" }, [
      el("span", { className: "watch-progress-filter-label", textContent: "观看进度" }),
      el("select", { title: "观看进度筛选", dataset: { role: "watch-progress-preset" } }, watchProgressFilterOptions(current))
    ]);
  }

  function watchProgressFilterOptions(current) {
    const presets = core.WATCH_PROGRESS_FILTER_PRESETS;
    return [
      option(presets.ALL, "全部进度", current),
      option(presets.NOT_STARTED, "未开始", current),
      option(presets.IN_PROGRESS, "观看中", current),
      option(presets.COMPLETED, "已看完", current)
    ];
  }

  function durationFilterOptions(current) {
    const presets = core.DURATION_FILTER_PRESETS;
    return [
      option(presets.ALL, "全部时长", current),
      option(presets.UNDER_10, "少于 10 分钟", current),
      option(presets.FROM_10_TO_30, "10-30 分钟", current),
      option(presets.FROM_30_TO_60, "30-60 分钟", current),
      option(presets.OVER_60, "60 分钟以上", current),
      option(presets.UNKNOWN, "时长未知", current),
      option(presets.CUSTOM, "自定义范围", current)
    ];
  }

  function failedBatchCount() {
    return (llmRun.batches || []).filter((batch) => batch.status === "failed").length;
  }

  function labeledInput(label, role, value, placeholder, type) {
    return el("label", { className: "field" }, [
      el("span", { textContent: label }),
      el("input", {
        type: type || "text",
        value,
        placeholder,
        dataset: { role }
      })
    ]);
  }

  function renderApiSettings() {
    return el("section", { className: "fold settings-panel", dataset: { fold: "settings-panel" } }, [
      el("button", { className: "fold-head", dataset: { action: "toggle-settings-panel" } }, [
        el("h2", { textContent: "设置" }),
        el("span", { dataset: { role: "fold-icon" }, textContent: settingsPanelOpen ? "⌃" : "⌄" })
      ]),
      el("div", { className: "fold-body settings-body" + (settingsPanelOpen ? "" : " hidden") }, [
        renderApiSettingsSection(),
        renderAutoLlmSettingsSection(),
        renderDataBackup()
      ])
    ]);
  }

  function renderApiSettingsSection() {
    const settings = Object.assign({}, state.settings || {}, apiSettingsDraft || {});
    return el("section", { className: "settings-subfold", dataset: { fold: "api-settings" } }, [
      el("button", { className: "settings-subhead", dataset: { action: "toggle-api-settings" } }, [
        el("h3", { textContent: "API 设置" }),
        el("span", { dataset: { role: "fold-icon" }, textContent: apiSettingsOpen ? "⌃" : "⌄" })
      ]),
      el("div", { className: "settings-subbody" + (apiSettingsOpen ? "" : " hidden") }, [
        el("div", { className: "api-settings-heading" }, [
          el("p", { textContent: "分类目录生成和 AI 批量视频分类共用这里保存的 OpenAI-compatible API。" })
        ]),
        el("div", { className: "llm-grid" }, [
          labeledInput("API URL", "llm-base-url", settings.llmBaseUrl || "", "https://openrouter.ai/api/v1", "url"),
          el("label", { className: "field" }, [
            el("span", { textContent: "接口格式" }),
            el("select", { dataset: { role: "llm-api-format" } }, [
              el("option", { value: core.LLM_API_FORMATS.CHAT_COMPLETIONS, textContent: "Chat Completions (/v1/chat/completions)", selected: core.normalizeLlmApiFormat(settings.llmApiFormat) === core.LLM_API_FORMATS.CHAT_COMPLETIONS }),
              el("option", { value: core.LLM_API_FORMATS.RESPONSES, textContent: "Responses (/v1/responses)", selected: core.normalizeLlmApiFormat(settings.llmApiFormat) === core.LLM_API_FORMATS.RESPONSES })
            ])
          ]),
          labeledInput("Model", "llm-model", settings.llmModel || "", "例如 openai/gpt-4.1-mini", "text"),
          labeledInput("API Key", "llm-api-key", settings.llmApiKey || "", "sk-...", "password"),
          labeledInput("温度", "llm-temperature", settings.llmTemperature == null ? 0.1 : settings.llmTemperature, "0.1", "number")
        ]),
        el("label", { className: "inline-check" }, [
          el("input", { type: "checkbox", checked: settings.llmUseResponseFormat === true, dataset: { role: "llm-use-response-format" } }),
          text("请求结构化 JSON 输出")
        ]),
        el("div", { className: "llm-actions" }, [
          el("button", { className: "primary", dataset: { action: "save-llm-settings" }, textContent: "保存 API 设置" }),
          el("button", { dataset: { action: "test-llm-api" }, textContent: apiTestState.running ? "正在测试…" : "测试 API" })
        ]),
        apiTestState.message ? el("div", { className: "api-test-status", textContent: apiTestState.message }) : null
      ].filter(Boolean))
    ]);
  }

  function renderAutoLlmSettingsSection() {
    const settings = Object.assign({}, state.settings || {}, autoApiSettingsDraft || {});
    const mode = settings.llmAutoClassifyMode || "off";
    return el("section", { className: "settings-subfold", dataset: { fold: "auto-api-settings" } }, [
      el("button", { className: "settings-subhead", dataset: { action: "toggle-auto-api-settings" } }, [
        el("h3", { textContent: "自动 API 视频分类" }),
        el("span", { dataset: { role: "fold-icon" }, textContent: autoApiSettingsOpen ? "⌃" : "⌄" })
      ]),
      el("div", { className: "settings-subbody" + (autoApiSettingsOpen ? "" : " hidden") }, [
        el("p", { className: "settings-help", textContent: "自动处理待精细分类的视频，手动确认始终跳过。数量模式会在打开或刷新整理助手，以及点击“同步并更新”后检查一次；浏览器需保持运行。" }),
        el("label", { className: "field" }, [
          el("span", { textContent: "自动分类条件" }),
          el("select", { dataset: { role: "llm-auto-classify-mode" } }, [
            option("off", "关闭", mode),
            option("daily", "每天", mode),
            option("weekly", "每周", mode),
            option("threshold", "待精细分类达到指定数量", mode)
          ])
        ]),
        labeledInput("待精细分类达到数量（仅数量模式）", "llm-auto-classify-threshold", settings.llmAutoClassifyThreshold || 50, "50", "number"),
        el("div", { className: "auto-api-status" }, [
          el("div", { textContent: "上次运行：" + formatSettingsTime(settings.llmAutoClassifyLastRunAt) }),
          el("div", { textContent: settings.llmAutoClassifyLastStatus || "尚未自动运行" })
        ]),
        el("div", { className: "llm-actions" }, [
          el("button", { className: "primary", dataset: { action: "save-auto-llm-settings" }, textContent: "保存自动分类设置" })
        ])
      ])
    ]);
  }

  function renderDataBackup() {
    return el("section", { className: "settings-subfold data-backup", dataset: { fold: "data-backup" } }, [
      el("div", { className: "settings-subhead data-backup-heading" }, [
        el("h3", { textContent: "数据备份" })
      ]),
      el("div", { className: "settings-subbody" }, [
        el("p", { className: "settings-help", textContent: "导出分类目录、视频信息、视频分类和设置，方便迁移到另一份扩展数据。导入会合并视频记录，现有手动确认不会被覆盖。" }),
        el("p", { className: "settings-warning", textContent: "备份文件包含 API Key，请妥善保管，不要上传到公开位置。" }),
        el("div", { className: "data-backup-actions" }, [
          el("button", { className: "primary", dataset: { action: "export-data" }, textContent: dataBackupState.running ? "正在导出…" : "导出本地数据" }),
          el("button", { className: "ghost", dataset: { action: "choose-data-import" }, textContent: "选择备份文件" }),
          el("input", { className: "data-backup-file", type: "file", accept: ".json,application/json", dataset: { role: "data-import-file" }, style: "display:none;" })
        ]),
        dataBackupState.message ? el("div", { className: "data-backup-status", textContent: dataBackupState.message }) : null
      ].filter(Boolean))
    ]);
  }

  function onClick(event) {
    const link = event.target.closest("a");
    if (link) return;
    const target = event.target.closest("[data-action]");
    if (!target) {
      const grid = event.target.closest(".grid");
      if (!batchMode && grid && event.target === grid && selectedBvid) {
        selectedBvid = "";
        updateSelectedVideoUi();
        renderEditorOnly();
      }
      return;
    }
    const action = target.dataset.action;
    if (action === "retry-onboarding-login") {
      checkOnboardingLoginAndSync();
    } else if (action === "choose-onboarding-method") {
      chooseOnboardingMethod(target.dataset.method);
    } else if (action === "back-onboarding-setup") {
      backToOnboardingSetup();
    } else if (action === "back-onboarding-guide") {
      backToOnboardingGuide();
    } else if (action === "back-onboarding-method") {
      backToOnboardingMethod();
    } else if (action === "save-onboarding-api") {
      saveOnboardingApi();
    } else if (action === "open-onboarding-api-settings") {
      openOnboardingApiSettings();
    } else if (action === "resume-onboarding-api") {
      onboardingPanelDismissed = false;
      renderShell();
    } else if (action === "reopen-onboarding-categories") {
      reopenOnboardingCategories();
    } else if (action === "adjust-onboarding-result") {
      adjustOnboardingCategoryResult();
    } else if (action === "show-onboarding-guide") {
      showOnboardingGuide();
    } else if (action === "start-onboarding-classify") {
      startOnboardingClassification(target.dataset.mode);
    } else if (action === "complete-onboarding") {
      completeOnboarding("首次引导已完成，所有分类方式仍可随时使用");
    } else if (action === "set-browse-mode") {
      setBrowseMode(target.dataset.mode);
    } else if (action === "set-video-view") {
      setVideoViewMode(target.dataset.mode);
    } else if (action === "filter-all") {
      activeFilter = emptyFilterWithDuration();
      renderShell();
    } else if (action === "filter-unclassified") {
      activeFilter = Object.assign(emptyFilterWithDuration(), { includeUnclassified: true });
      renderShell();
    } else if (action === "filter-category") {
      if (suppressCategoryClick) return;
      const categoryId = target.dataset.categoryId;
      activeFilter = activeFilter.sourceCategoryId === categoryId
        ? emptyFilterWithDuration()
        : Object.assign(emptyFilterWithDuration(), { categoryIds: expandCategoryIds([categoryId]), sourceCategoryId: categoryId });
      renderShell();
    } else if (action === "toggle-category-collapse") {
      toggleCategoryCollapse(target.dataset.categoryId);
    } else if (action === "filter-up") {
      const upGroupKey = target.dataset.upGroupKey || "";
      activeFilter = activeFilter.upGroupKey === upGroupKey
        ? emptyFilterWithDuration()
        : Object.assign(emptyFilterWithDuration(), { upGroupKey });
      renderShell();
    } else if (action === "select-video") {
      if (suppressNextCardClick) {
        suppressNextCardClick = false;
        return;
      }
      if (hasActiveTextSelection(target)) return;
      if (batchMode) {
        toggleSelectedBvid(target.dataset.bvid);
        updateSelectionUi();
        renderEditorOnly();
      } else {
        selectedBvid = target.dataset.bvid;
        manualEditorOpen = true;
        updateSelectedVideoUi();
        renderEditorOnly();
      }
    } else if (action === "toggle-batch") {
      batchMode = !batchMode;
      if (!batchMode) selectedBvids = new Set();
      renderShell();
    } else if (action === "batch-select-all") {
      selectedBvids = new Set(visibleVideos().map((video) => video.bvid));
      renderShell();
    } else if (action === "batch-clear-selection") {
      selectedBvids = new Set();
      renderShell();
    } else if (action === "batch-add-category") {
      bulkAddCategory();
    } else if (action === "batch-clear-categories") {
      bulkClearCategories();
    } else if (action === "bulk-remove-watchlater") {
      bulkRemoveFromWatchlater();
    } else if (action === "create-favorite-folder") {
      createFavoriteFolder();
    } else if (action === "save-llm-settings") {
      saveLlmSettings();
    } else if (action === "save-auto-llm-settings") {
      saveAutoLlmSettings();
    } else if (action === "test-llm-api") {
      testLlmApi();
    } else if (action === "export-data") {
      exportDataBackup();
    } else if (action === "choose-data-import") {
      const input = nodeByRole("data-import-file");
      if (input) input.click();
    } else if (action === "open-api-settings") {
      openApiSettings("请在“设置”中填写、保存并测试 API");
    } else if (action === "start-llm-run") {
      startLlmRun();
    } else if (action === "stop-llm-run") {
      stopLlmRun();
    } else if (action === "toggle-manual-editor") {
      manualEditorOpen = !manualEditorOpen;
      toggleFoldNode("manual-editor", manualEditorOpen);
    } else if (action === "toggle-llm-panel") {
      llmPanelOpen = !llmPanelOpen;
      toggleFoldNode("llm-panel", llmPanelOpen);
    } else if (action === "toggle-settings-panel") {
      settingsPanelOpen = !settingsPanelOpen;
      toggleFoldNode("settings-panel", settingsPanelOpen);
    } else if (action === "toggle-api-settings") {
      apiSettingsOpen = !apiSettingsOpen;
      toggleFoldNode("api-settings", apiSettingsOpen);
    } else if (action === "toggle-auto-api-settings") {
      autoApiSettingsOpen = !autoApiSettingsOpen;
      toggleFoldNode("auto-api-settings", autoApiSettingsOpen);
    } else if (action === "toggle-category-admin") {
      categoryAdminOpen = !categoryAdminOpen;
      toggleFoldNode("category-admin", categoryAdminOpen);
    } else if (action === "sync-refresh") {
      syncAndRefresh();
    } else if (action === "scan") {
      scan();
    } else if (action === "details") {
      runDetails();
    } else if (action === "auto-classify") {
      autoClassify();
    } else if (action === "add-category") {
      addCategory();
    } else if (action === "delete-category") {
      deleteCategory(target.dataset.categoryId);
    } else if (action === "save-category-draft") {
      saveCategoryDraft();
    } else if (action === "discard-category-draft") {
      discardCategoryDraft();
    } else if (action === "generate-categories-api") {
      generateCategoriesWithApi();
    } else if (action === "save-manual") {
      saveManualClassification(target.dataset.bvid);
    } else if (action === "remove-watchlater") {
      removeFromWatchlater(target.dataset.bvid);
    } else if (action === "open-watchlater") {
      window.open("https://www.bilibili.com/watchlater/list#/list", "_blank", "noopener");
    } else if (action === "open-bili-home") {
      window.open("https://www.bilibili.com/", "_blank", "noopener");
    } else if (action === "open-bili-dynamic") {
      window.open("https://t.bilibili.com/", "_blank", "noopener");
    }
  }

  function emptyFilter() {
    return {
      categoryIds: [],
      includeUnclassified: false,
      includeRemoved: false,
      sourceCategoryId: "",
      upGroupKey: "",
      watchProgressPreset: core.WATCH_PROGRESS_FILTER_PRESETS.ALL,
      durationPreset: core.DURATION_FILTER_PRESETS.ALL,
      durationMin: "",
      durationMax: ""
    };
  }

  function emptyFilterWithDuration() {
    return Object.assign(emptyFilter(), {
      watchProgressPreset: core.normalizeWatchProgressFilterPreset(activeFilter.watchProgressPreset),
      durationPreset: core.normalizeDurationFilterPreset(activeFilter.durationPreset),
      durationMin: activeFilter.durationMin == null ? "" : activeFilter.durationMin,
      durationMax: activeFilter.durationMax == null ? "" : activeFilter.durationMax
    });
  }

  async function setBrowseMode(modeValue) {
    const nextMode = core.normalizeBrowseMode(modeValue);
    if (nextMode === browseMode()) return;
    activeFilter = emptyFilterWithDuration();
    selectedBvids = new Set();
    try {
      updateState(await send({
        type: message.UPDATE_SETTINGS,
        settings: { browseMode: nextMode }
      }));
      setStatus(nextMode === core.BROWSE_MODES.UP ? "已切换为按 UP 主浏览" : "已切换为按分类目录浏览");
    } catch (error) {
      setStatus("保存浏览模式失败：" + error.message);
    }
  }

  function toggleCategoryCollapse(categoryId) {
    const category = state.categories.find((item) => item.id === categoryId);
    if (!category || category.parentId || !core.childrenOf(state.categories, categoryId).length) return;

    const previousIds = collapsedCategoryIds();
    const nextIds = new Set(previousIds);
    if (nextIds.has(categoryId)) nextIds.delete(categoryId);
    else nextIds.add(categoryId);
    const normalizedIds = core.normalizeCollapsedCategoryIds(Array.from(nextIds));
    state = Object.assign({}, state, {
      settings: Object.assign({}, state.settings, { collapsedCategoryIds: normalizedIds })
    });
    renderShell();

    const changeId = ++categoryCollapseChangeId;
    categoryCollapseSaveQueue = categoryCollapseSaveQueue
      .catch(() => {})
      .then(() => send({
        type: message.UPDATE_SETTINGS,
        settings: { collapsedCategoryIds: normalizedIds }
      }))
      .then((nextState) => {
        if (changeId === categoryCollapseChangeId) updateState(nextState);
      })
      .catch((error) => {
        if (changeId !== categoryCollapseChangeId) return;
        state = Object.assign({}, state, {
          settings: Object.assign({}, state.settings, { collapsedCategoryIds: previousIds })
        });
        renderShell();
        setStatus("保存分类目录显示设置失败：" + error.message);
      });
  }

  function setVideoViewMode(modeValue) {
    const nextMode = core.normalizeVideoViewMode(modeValue);
    const previousMode = videoViewMode();
    if (nextMode === previousMode) return;
    const changeId = ++videoViewChangeId;
    state = Object.assign({}, state, {
      settings: Object.assign({}, state.settings, { videoViewMode: nextMode })
    });
    renderShell();

    videoViewSaveQueue = videoViewSaveQueue
      .catch(() => {})
      .then(() => send({
        type: message.UPDATE_SETTINGS,
        settings: { videoViewMode: nextMode }
      }))
      .then((nextState) => {
        if (changeId !== videoViewChangeId) return;
        updateState(nextState);
        setStatus(nextMode === core.VIDEO_VIEW_MODES.LIST ? "已切换为列表视图" : "已切换为卡片视图");
      })
      .catch((error) => {
        if (changeId !== videoViewChangeId) return;
        state = Object.assign({}, state, {
          settings: Object.assign({}, state.settings, { videoViewMode: previousMode })
        });
        renderShell();
        setStatus("保存视图设置失败：" + error.message);
      });
  }

  async function chooseOnboardingMethod(methodValue) {
    const methodName = ["categories", "api"].includes(methodValue) ? methodValue : "categories";
    onboardingPanelDismissed = methodName === "categories";
    if (methodName === "categories") categoryAdminOpen = true;
    try {
      await updateOnboardingSettings({ onboardingStage: "setup-" + methodName, onboardingMethod: methodName });
      if (methodName === "categories") revealOnboardingPanel(methodName);
    } catch (error) {
      onboardingPanelDismissed = false;
      setStatus("保存首次设置失败：" + error.message);
      renderShell();
    }
  }

  async function backToOnboardingSetup() {
    if (onboardingCategoryRunning) {
      setStatus("分类目录正在生成，请等待当前请求完成");
      return;
    }
    onboardingPanelDismissed = false;
    onboardingCategoryMessage = "";
    try {
      await updateOnboardingSettings({ onboardingStage: "setup", onboardingMethod: "" });
    } catch (error) {
      setStatus("返回首次设置失败：" + error.message);
    }
  }

  async function backToOnboardingGuide() {
    onboardingPanelDismissed = false;
    try {
      await updateOnboardingSettings({ onboardingStage: "guide" });
    } catch (error) {
      setStatus("返回分类说明失败：" + error.message);
    }
  }

  async function backToOnboardingMethod() {
    if (onboardingCategoryRunning) {
      setStatus("分类目录正在生成，请等待当前请求完成");
      return;
    }
    const methodName = core.normalizeText(state.settings && state.settings.onboardingMethod);
    const stage = methodName === "api" ? "setup-api" : "setup";
    onboardingPanelDismissed = false;
    try {
      await updateOnboardingSettings({ onboardingStage: stage });
    } catch (error) {
      setStatus("返回分类目录设置步骤失败：" + error.message);
    }
  }

  async function saveOnboardingApi() {
    if (onboardingCategoryRunning) return;
    const config = Object.assign({}, state.settings || {});
    if (!apiSettingsReady(config)) {
      openOnboardingApiSettings();
      setStatus("API 尚未设置完整，请先在“设置”中填写并测试 API");
      return;
    }
    setStatus("正在让 AI 生成新的分类目录…");
    try {
      onboardingCategoryRunning = true;
      onboardingCategoryMessage = "正在读取现有视频信息并请求 AI…";
      renderShell();
      const exported = await send({ type: message.EXPORT_CATEGORY_PROPOSAL });
      onboardingCategoryMessage = "已准备 " + (exported.sampleCount || 0) + " 个视频的信息，正在生成分类目录...";
      renderShell();
      const payload = await callCategoryLlm(config, exported.prompt || "");
      onboardingCategoryRunning = false;
      onboardingCategoryMessage = "";
      await confirmAndImportCategories(payload, "api", "API");
    } catch (error) {
      onboardingCategoryRunning = false;
      onboardingCategoryMessage = "更新失败：" + error.message;
      openOnboardingApiSettings();
      setStatus("AI 生成分类目录失败：" + error.message + "；请先在“设置”中检查并测试 API");
    }
  }

  function openOnboardingApiSettings() {
    onboardingPanelDismissed = true;
    settingsPanelOpen = true;
    apiSettingsOpen = true;
    renderShell();
  }

  async function handleOnboardingCategoryImport(result, sourceLabel) {
    updateState(result);
    onboardingPanelDismissed = false;
    await updateOnboardingSettings({ onboardingStage: "setup-result" });
    await syncAfterCategoryListChange("分类目录已替换");
    const imported = result.categoryImportResult || {};
    setStatus(sourceLabel + " 已生成新的分类目录：" + (imported.imported || state.categories.length) + " 项");
  }

  function reopenOnboardingCategories() {
    onboardingPanelDismissed = true;
    categoryAdminOpen = true;
    renderShell();
    revealOnboardingPanel("categories");
  }

  async function adjustOnboardingCategoryResult() {
    onboardingPanelDismissed = true;
    categoryAdminOpen = true;
    try {
      await updateOnboardingSettings({ onboardingStage: "setup-categories" });
      revealOnboardingPanel("categories");
    } catch (error) {
      onboardingPanelDismissed = false;
      setStatus("打开编辑分类目录失败：" + error.message);
    }
  }

  function revealOnboardingPanel(methodName) {
    const foldName = methodName === "categories"
      ? "category-admin"
        : methodName === "manual"
          ? "manual-editor"
          : "llm-panel";
    setTimeout(() => {
      const node = document.querySelector('[data-fold="' + foldName + '"]');
      if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  async function showOnboardingGuide() {
    onboardingPanelDismissed = false;
    try {
      await updateOnboardingSettings({ onboardingStage: "guide" });
    } catch (error) {
      setStatus("打开分类说明失败：" + error.message);
    }
  }

  async function startOnboardingClassification(modeValue) {
    const modeName = ["manual", "api"].includes(modeValue) ? modeValue : "manual";
    onboardingPanelDismissed = true;
    if (modeName === "manual") manualEditorOpen = true;
    if (modeName === "api") llmPanelOpen = true;
    if (modeName === "api" && !apiSettingsReady(state.settings || {})) {
      settingsPanelOpen = true;
      apiSettingsOpen = true;
    }
    try {
      await updateOnboardingSettings({ onboardingStage: "classify" });
      if (modeName === "api" && !apiSettingsReady(state.settings || {})) {
        setStatus("API 尚未设置完整，请先在“设置”中填写并测试 API");
      }
      revealOnboardingPanel(modeName === "manual" ? "manual" : modeName);
    } catch (error) {
      onboardingPanelDismissed = false;
      setStatus("启动首次分类失败：" + error.message);
      renderShell();
    }
  }

  async function completeOnboarding(statusMessage) {
    onboardingPanelDismissed = false;
    try {
      await updateOnboardingSettings({
        onboardingEligible: false,
        onboardingCompleted: true,
        onboardingStage: "complete"
      });
      if (statusMessage) setStatus(statusMessage);
    } catch (error) {
      setStatus("结束首次引导失败：" + error.message);
    }
  }

  function onDragStart(event) {
    if (event.target && event.target.closest && event.target.closest(".category-collapse-toggle")) {
      event.preventDefault();
      return;
    }
    const group = event.target.closest(".category-tree-group[data-category-group]");
    if (!group || !group.draggable) return;
    draggedCategoryId = group.dataset.categoryGroup || "";
    dragDropPosition = "before";
    suppressCategoryClick = true;
    group.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedCategoryId);
      event.dataTransfer.setDragImage(group, 18, 18);
    }
  }

  function onDragOver(event) {
    const group = categoryDropTargetGroup(event.target, draggedCategoryId);
    if (!group || !draggedCategoryId || group.dataset.categoryGroup === draggedCategoryId) return;
    if (!canDropCategory(draggedCategoryId, group.dataset.categoryGroup)) return;
    event.preventDefault();
    dragDropPosition = categoryDropPosition(group, event.clientY);
    document.querySelectorAll(".drop-before,.drop-after").forEach((node) => {
      if (node !== group) node.classList.remove("drop-before", "drop-after");
    });
    group.classList.toggle("drop-before", dragDropPosition === "before");
    group.classList.toggle("drop-after", dragDropPosition === "after");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  async function onDrop(event) {
    const group = categoryDropTargetGroup(event.target, draggedCategoryId);
    if (!group || !draggedCategoryId) return;
    const targetId = group.dataset.categoryGroup || "";
    const position = categoryDropPosition(group, event.clientY);
    clearDragClasses();
    if (!targetId || targetId === draggedCategoryId || !canDropCategory(draggedCategoryId, targetId)) {
      draggedCategoryId = "";
      releaseCategoryClickSuppression();
      return;
    }
    event.preventDefault();
    setStatus("正在调整分类顺序...");
    try {
      updateState(await send({
        type: message.REORDER_CATEGORY,
        id: draggedCategoryId,
        targetId,
        position
      }));
      setStatus("已调整分类顺序；未触发视频同步或重新分类");
    } catch (error) {
      setStatus("排序失败：" + error.message);
    } finally {
      draggedCategoryId = "";
      releaseCategoryClickSuppression();
    }
  }

  function onDragEnd() {
    clearDragClasses();
    draggedCategoryId = "";
    releaseCategoryClickSuppression();
  }

  function releaseCategoryClickSuppression() {
    setTimeout(() => {
      suppressCategoryClick = false;
    }, 120);
  }

  function clearDragClasses() {
    document.querySelectorAll(".dragging,.drop-before,.drop-after").forEach((node) => {
      node.classList.remove("dragging", "drop-before", "drop-after");
    });
  }

  function categoryDropTargetGroup(target, draggedId) {
    const dragged = state.categories.find((item) => item.id === draggedId);
    let group = target && target.closest ? target.closest(".category-tree-group[data-category-group]") : null;
    while (group && dragged) {
      const category = state.categories.find((item) => item.id === group.dataset.categoryGroup);
      if (category && (category.parentId || "") === (dragged.parentId || "")) return group;
      group = group.parentElement && group.parentElement.closest(".category-tree-group[data-category-group]");
    }
    return null;
  }

  function categoryDropPosition(group, clientY) {
    const row = group.querySelector(".category-row-layout > .cat-row");
    if (!row) return "before";
    const rect = row.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function canDropCategory(id, targetId) {
    const category = state.categories.find((item) => item.id === id);
    const target = state.categories.find((item) => item.id === targetId);
    return Boolean(category && target && (category.parentId || "") === (target.parentId || ""));
  }

  function onInput(event) {
    if (event.target.dataset.role === "search") {
      searchText = event.target.value;
      renderVideoResults();
    } else if (["llm-base-url", "llm-api-format", "llm-model", "llm-api-key", "llm-temperature", "llm-use-response-format"].includes(event.target.dataset.role)) {
      apiSettingsDraft = collectApiSettings();
    } else if (event.target.dataset.role === "llm-auto-classify-threshold") {
      autoApiSettingsDraft = collectAutoLlmSettings();
    } else if (event.target.dataset.role === "favorite-folder-title") {
      favoriteFolderTitle = event.target.value;
      updateFavoriteFolderUi();
    } else if (event.target.dataset.role === "category-name") {
      const category = ensureCategoryDraft().find((item) => item.id === event.target.dataset.categoryId);
      if (category) category.name = event.target.value;
      categoryDraftDirty = true;
    }
  }

  function onPointerDown(event) {
    if (!batchMode || event.button !== 0) return;
    if (event.target.closest("button,a,input,select,textarea")) return;
    const content = event.target.closest(".content");
    const inGrid = Boolean(event.target.closest(".grid"));
    if (!content || (!inGrid && event.target !== content)) return;
    const scrollNode = event.target.closest(".main") || document.scrollingElement || document.documentElement;
    const start = pointInScrollNode(event, scrollNode);
    const startCard = event.target.closest(".video-card[data-bvid]");
    if (app.setPointerCapture) {
      try {
        app.setPointerCapture(event.pointerId);
      } catch (error) {}
    }
    selectionBox = {
      scrollNode,
      startX: start.x,
      startY: start.y,
      currentX: start.x,
      currentY: start.y,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      baseSelection: new Set(selectedBvids),
      hasMoved: false,
      startedOnCard: Boolean(startCard),
      startBvid: startCard ? startCard.dataset.bvid : ""
    };
  }

  function onPointerMove(event) {
    if (!selectionBox) return;
    updateSelectionPoint(event.clientX, event.clientY);
    if (!selectionBox.hasMoved) return;
    event.preventDefault();
    updateSelectionFromBox();
    updateSelectionUi();
  }

  function onPointerUp(event) {
    if (!selectionBox) return;
    const cancelled = event && event.type === "pointercancel";
    const moved = selectionBox.hasMoved;
    if (!cancelled && moved) {
      updateSelectionFromBox();
      suppressNextCardClick = selectionBox.startedOnCard;
      if (suppressNextCardClick) {
        setTimeout(() => {
          suppressNextCardClick = false;
        }, 120);
      }
    } else if (!cancelled && selectionBox.startedOnCard && selectionBox.startBvid) {
      toggleSelectedBvid(selectionBox.startBvid);
      suppressNextCardClick = true;
      setTimeout(() => {
        suppressNextCardClick = false;
      }, 120);
    }
    selectionBox = null;
    if (event && app.releasePointerCapture) {
      try {
        app.releasePointerCapture(event.pointerId);
      } catch (error) {}
    }
    hideSelectionBox();
    if (!cancelled && (moved || suppressNextCardClick)) updateSelectionUi();
    if (!cancelled && (moved || suppressNextCardClick)) renderEditorOnly();
  }

  function onWheel(event) {
    if (draggedCategoryId) {
      const categoryNav = document.querySelector(".cat-nav");
      if (categoryNav && event.deltaY) {
        categoryNav.scrollTop += event.deltaY;
        event.preventDefault();
      }
      return;
    }
    if (!selectionBox || !selectionBox.hasMoved) return;
    scheduleSelectionScrollUpdate();
  }

  function onSelectionScroll() {
    if (!selectionBox) return;
    scheduleSelectionScrollUpdate();
  }

  function scheduleSelectionScrollUpdate() {
    requestAnimationFrame(() => {
      if (!selectionBox) return;
      updateSelectionPoint(selectionBox.lastClientX, selectionBox.lastClientY);
      if (!selectionBox.hasMoved) return;
      updateSelectionFromBox();
      updateSelectionUi();
    });
  }

  function updateSelectionFromBox() {
    if (!selectionBox) return;
    const box = normalizeBox(selectionBox);
    const next = new Set(selectionBox.baseSelection);
    document.querySelectorAll(".video-card[data-bvid]").forEach((card) => {
      const rect = rectInScrollNode(card, selectionBox.scrollNode);
      const cardBox = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
      if (intersects(box, cardBox)) next.add(card.dataset.bvid);
    });
    selectedBvids = next;
  }

  function updateSelectionUi() {
    const boxNode = document.querySelector(".selection-box");
    if (boxNode && selectionBox && selectionBox.hasMoved) {
      const box = normalizeBox(selectionBox);
      const viewportBox = boxToViewport(box, selectionBox.scrollNode);
      boxNode.classList.remove("hidden");
      boxNode.style.left = viewportBox.left + "px";
      boxNode.style.top = viewportBox.top + "px";
      boxNode.style.width = (viewportBox.right - viewportBox.left) + "px";
      boxNode.style.height = (viewportBox.bottom - viewportBox.top) + "px";
    }
    document.querySelectorAll(".video-card[data-bvid]").forEach((card) => {
      const selected = selectedBvids.has(card.dataset.bvid);
      card.classList.toggle("batch-selected", selected);
      const mark = card.querySelector(".select-mark");
      if (mark) mark.textContent = selected ? "✓" : "";
    });
    updateBatchCounts();
    updateFavoriteFolderUi();
    updateBulkRemoveUi();
  }

  function updateSelectedVideoUi() {
    document.querySelectorAll(".video-card[data-bvid]").forEach((card) => {
      card.classList.toggle("selected", !batchMode && card.dataset.bvid === selectedBvid);
    });
  }

  function hideSelectionBox() {
    const boxNode = document.querySelector(".selection-box");
    if (!boxNode) return;
    boxNode.classList.add("hidden");
    boxNode.style.left = "";
    boxNode.style.top = "";
    boxNode.style.width = "";
    boxNode.style.height = "";
  }

  function updateBatchCounts() {
    const panelCount = document.querySelector('[data-role="batch-panel-count"]');
    if (panelCount) panelCount.textContent = batchPanelCountText();
    const editorCount = document.querySelector('[data-role="batch-editor-count"]');
    if (editorCount) editorCount.textContent = batchEditorCountText();
  }

  function updateFavoriteFolderUi() {
    const count = document.querySelector('[data-role="favorite-panel-count"]');
    if (count) count.textContent = "当前选择 " + selectedBvids.size + " 个视频";
    const button = document.querySelector('[data-action="create-favorite-folder"]');
    if (button) {
      button.disabled = favoriteRun.running || !selectedBvids.size || !core.normalizeText(favoriteFolderTitle);
      button.textContent = favoriteRun.running ? "正在创建并加入…" : "新建收藏夹并加入";
    }
  }

  function updateBulkRemoveUi() {
    const button = document.querySelector('[data-action="bulk-remove-watchlater"]');
    if (!button) return;
    button.disabled = favoriteRun.running || bulkRemoveRun.running || !selectedBvids.size;
    button.textContent = bulkRemoveRun.running ? "正在批量移出…" : "批量移出稍后再看";
  }

  function batchPanelCountText() {
    return "已选择 " + selectedBvids.size + " 个视频。可点击卡片、框选，或全选当前结果。";
  }

  function batchEditorCountText() {
    return "已选择 " + selectedBvids.size + " 个视频";
  }

  function favoriteResultText(result) {
    const folder = result && result.folder || {};
    const failedText = result.failed ? "，失败 " + result.failed + " 个" : "";
    return "已创建私密收藏夹“" + (folder.title || "新收藏夹") + "”：成功加入 " + (result.added || 0) + " 个，跳过 " + (result.skipped || 0) + " 个" + failedText + "。";
  }

  async function createFavoriteFolder() {
    if (favoriteRun.running) return;
    const title = core.normalizeText(favoriteFolderTitle);
    if (!title) {
      setStatus("请填写收藏夹名称");
      return;
    }
    if (!selectedBvids.size) {
      setStatus("请先选择视频");
      return;
    }

    favoriteRun = { running: true, result: null, message: "正在创建收藏夹并加入视频…" };
    renderShell();
    setStatus("正在创建收藏夹并加入视频…");
    try {
      const result = await send({
        type: message.CREATE_FAVORITE_FOLDER_AND_ADD,
        title,
        bvids: Array.from(selectedBvids)
      });
      const output = result.favoriteResult || {};
      favoriteRun = {
        running: false,
        result: output,
        message: favoriteResultText(output)
      };
      updateState(result);
      setStatus(favoriteRun.message);
    } catch (error) {
      favoriteRun = {
        running: false,
        result: null,
        message: "创建收藏夹失败：" + error.message
      };
      renderShell();
      setStatus("创建收藏夹失败：" + error.message);
    }
  }

  function updateBatchCategorySwatch() {
    const category = state.categories.find((item) => item.id === batchCategoryId);
    const swatch = document.querySelector('[data-role="batch-category-swatch"]');
    if (category && swatch) swatch.setAttribute("style", categoryStyle(category, "swatch"));
  }

  function updateSelectionPoint(clientX, clientY) {
    if (!selectionBox) return;
    selectionBox.lastClientX = clientX;
    selectionBox.lastClientY = clientY;
    const point = pointInScrollNode({ clientX, clientY }, selectionBox.scrollNode);
    selectionBox.currentX = point.x;
    selectionBox.currentY = point.y;
    if (Math.abs(selectionBox.currentX - selectionBox.startX) > 4 || Math.abs(selectionBox.currentY - selectionBox.startY) > 4) {
      selectionBox.hasMoved = true;
    }
  }

  function pointInScrollNode(event, scrollNode) {
    const rect = scrollNode.getBoundingClientRect ? scrollNode.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: event.clientX - rect.left + (scrollNode.scrollLeft || 0),
      y: event.clientY - rect.top + (scrollNode.scrollTop || 0)
    };
  }

  function rectInScrollNode(node, scrollNode) {
    const rect = node.getBoundingClientRect();
    const scrollRect = scrollNode.getBoundingClientRect ? scrollNode.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      left: rect.left - scrollRect.left + (scrollNode.scrollLeft || 0),
      top: rect.top - scrollRect.top + (scrollNode.scrollTop || 0),
      right: rect.right - scrollRect.left + (scrollNode.scrollLeft || 0),
      bottom: rect.bottom - scrollRect.top + (scrollNode.scrollTop || 0)
    };
  }

  function boxToViewport(box, scrollNode) {
    const scrollRect = scrollNode.getBoundingClientRect ? scrollNode.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      left: scrollRect.left + box.left - (scrollNode.scrollLeft || 0),
      top: scrollRect.top + box.top - (scrollNode.scrollTop || 0),
      right: scrollRect.left + box.right - (scrollNode.scrollLeft || 0),
      bottom: scrollRect.top + box.bottom - (scrollNode.scrollTop || 0)
    };
  }

  function hasActiveTextSelection(container) {
    const selection = window.getSelection && window.getSelection();
    if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
    const anchorNode = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
    const focusNode = selection.focusNode && (selection.focusNode.nodeType === 1 ? selection.focusNode : selection.focusNode.parentElement);
    return Boolean((anchorNode && container.contains(anchorNode)) || (focusNode && container.contains(focusNode)));
  }

  function normalizeBox(box) {
    return {
      left: Math.min(box.startX, box.currentX),
      top: Math.min(box.startY, box.currentY),
      right: Math.max(box.startX, box.currentX),
      bottom: Math.max(box.startY, box.currentY)
    };
  }

  function intersects(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function onChange(event) {
    const role = event.target.dataset.role;
    if (role === "data-import-file") {
      importDataBackupFile(event.target);
    } else if (role === "sort-combo") {
      const parsed = parseSortCombo(event.target.value);
      send({ type: message.UPDATE_SETTINGS, settings: parsed })
        .then(updateState)
        .catch((error) => setStatus(error.message));
    } else if (role === "sort-mode") {
      send({ type: message.UPDATE_SETTINGS, settings: { sortMode: event.target.value } })
        .then(updateState)
        .catch((error) => setStatus(error.message));
    } else if (role === "sort-direction") {
      send({ type: message.UPDATE_SETTINGS, settings: { sortDirection: event.target.value } })
        .then(updateState)
        .catch((error) => setStatus(error.message));
    } else if (role === "duration-preset") {
      const durationPreset = core.normalizeDurationFilterPreset(event.target.value);
      activeFilter = Object.assign({}, activeFilter, {
        durationPreset,
        durationMin: durationPreset === core.DURATION_FILTER_PRESETS.CUSTOM ? activeFilter.durationMin : "",
        durationMax: durationPreset === core.DURATION_FILTER_PRESETS.CUSTOM ? activeFilter.durationMax : ""
      });
      renderShell();
    } else if (role === "watch-progress-preset") {
      activeFilter = Object.assign({}, activeFilter, {
        watchProgressPreset: core.normalizeWatchProgressFilterPreset(event.target.value)
      });
      renderShell();
    } else if (["duration-min", "duration-max"].includes(role)) {
      applyCustomDurationFilter();
    } else if (role === "category-sample-limit") {
      const sampleLimit = Math.floor(Number(event.target.value));
      if (!Number.isFinite(sampleLimit) || sampleLimit < 1) {
        setStatus("分类目录样本数量至少为 1");
        return;
      }
      send({ type: message.UPDATE_SETTINGS, settings: { categorySampleLimit: sampleLimit } })
        .then(updateState)
        .catch((error) => setStatus(error.message));
    } else if (role === "llm-auto-classify-mode") {
      autoApiSettingsDraft = collectAutoLlmSettings();
    } else if (role === "llm-api-format") {
      apiSettingsDraft = collectApiSettings();
    } else if (role === "batch-category") {
      batchCategoryId = event.target.value;
      updateBatchCategorySwatch();
    } else if (role === "category-parent") {
      harvestCategoryDraft();
      categoryDraftDirty = true;
      renderEditorOnly();
    }
  }

  function renderVideoResults() {
    const content = document.querySelector('[data-role="content"]');
    if (content) content.replaceWith(renderContent(visibleVideos()));
    updateStatusSurface();
  }

  function renderEditorOnly() {
    const editor = document.querySelector(".editor");
    if (!editor) return;
    const scrollTop = editor.scrollTop;
    editor.replaceWith(renderEditor(visibleVideos()));
    const nextEditor = document.querySelector(".editor");
    if (nextEditor) nextEditor.scrollTop = scrollTop;
  }

  function toggleFoldNode(name, open) {
    const section = document.querySelector('[data-fold="' + name + '"]');
    if (!section) {
      renderEditorOnly();
      return;
    }
    const body = Array.from(section.children).find((child) => child.classList && (child.classList.contains("fold-body") || child.classList.contains("settings-subbody")));
    const head = section.firstElementChild;
    const icon = head && head.querySelector('[data-role="fold-icon"]');
    if (body) body.classList.toggle("hidden", !open);
    if (icon) icon.textContent = open ? "⌃" : "⌄";
  }

  function toggleSelectedBvid(bvid) {
    const next = new Set(selectedBvids);
    if (next.has(bvid)) next.delete(bvid);
    else next.add(bvid);
    selectedBvids = next;
  }

  async function bulkAddCategory() {
    const select = document.querySelector('[data-role="batch-category"]');
    if (!select) return;
    await bulkUpdate({ action: "add", categoryId: select.value });
  }

  async function bulkClearCategories() {
    if (!selectedBvids.size) {
      setStatus("请先选择视频");
      return;
    }
    if (!confirm("清除 " + selectedBvids.size + " 个选中视频的所有分类？")) return;
    await bulkUpdate({ action: "clear" });
  }

  function bulkRemoveResultText(result) {
    const removed = Number(result && result.successCount != null ? result.successCount : result && result.removed) || 0;
    const failed = Number(result && result.failureCount != null ? result.failureCount : result && result.failed) || 0;
    return "批量移出完成：成功 " + removed + " 个，失败 " + failed + " 个。" +
      (failed ? "失败的视频仍保留在选择中，可以重试。" : "本地视频记录和分类结果已保留。");
  }

  async function bulkRemoveFromWatchlater() {
    if (bulkRemoveRun.running || favoriteRun.running) return;
    const bvids = Array.from(selectedBvids);
    if (!bvids.length) {
      setStatus("请先选择视频");
      return;
    }
    const confirmed = await confirmAction({
      title: "批量移出稍后再看？",
      message: "将从 B站稍后再看中移出 " + bvids.length + " 个视频。\n本地视频记录、分类结果和手动确认会保留；失败的视频仍会保留在选择中。",
      confirmLabel: "批量移出"
    });
    if (!confirmed) return;

    bulkRemoveRun = { running: true, result: null, message: "正在批量移出稍后再看…", failed: false };
    renderShell();
    setStatus("正在批量移出稍后再看…");
    try {
      const result = await send({
        type: message.BULK_REMOVE_FROM_WATCHLATER,
        bvids
      });
      const output = result.bulkRemoveResult || {};
      const removed = new Set((output.removedBvids || []).map((bvid) => core.normalizeBvid(bvid)).filter(Boolean));
      selectedBvids = new Set(bvids.filter((bvid) => !removed.has(bvid)));
      bulkRemoveRun = {
        running: false,
        result: output,
        message: bulkRemoveResultText(output),
        failed: Boolean(output.failed)
      };
      updateState(result);
      setStatus(bulkRemoveRun.message);
    } catch (error) {
      bulkRemoveRun = {
        running: false,
        result: null,
        message: "批量移出失败：" + error.message,
        failed: true
      };
      renderShell();
      setStatus("批量移出稍后再看失败：" + error.message);
    }
  }

  async function bulkUpdate(payload) {
    if (!selectedBvids.size) {
      setStatus("请先选择视频");
      return;
    }
    setStatus("正在批量调整视频分类…");
    try {
      const result = await send(Object.assign({
        type: message.BULK_UPDATE_CLASSIFICATIONS,
        bvids: Array.from(selectedBvids)
      }, payload));
      updateState(result);
      const output = result.bulkUpdateResult || {};
      setStatus("批量更新完成：" + (output.updated || 0) + " 个视频");
      if (output.updated) await finishClassificationAndSync("批量手动确认已保存");
    } catch (error) {
      setStatus("批量更新失败：" + error.message);
    }
  }

  async function syncAndRefresh() {
    const synced = await scan();
    if (!synced) return;
    await checkAutoLlmOnRefresh();
    setStatus(scanStatusText(synced.scanResult, synced.autoClassifyResult) + "；正在更新详情...");
    await runDetails({ source: "manual-combined" });
  }

  async function checkAutoLlmOnRefresh() {
    try {
      updateState(await send({ type: message.CHECK_AUTO_LLM }));
    } catch (error) {
      setStatus("刷新时自动分类检查失败：" + error.message);
    }
  }

  async function syncAfterClassificationChange(reason) {
    setStatus((reason || "分类已更新") + "；正在自动同步并更新...");
    const synced = await scan();
    if (!synced) return false;
    await runDetails({ source: "classification-change" });
    return true;
  }

  async function syncAfterCategoryListChange(reason) {
    setStatus((reason || "分类目录已替换") + "；正在同步列表但暂不分类视频…");
    const synced = await scan({ skipAutoClassify: true });
    if (!synced) return false;
    await runDetails({ source: "category-list-change" });
    return true;
  }

  async function syncAfterCategoryStructureChange(reason) {
    if (onboardingActive() && onboardingStage() === "setup-categories") {
      return syncAfterCategoryListChange(reason);
    }
    return syncAfterClassificationChange(reason);
  }

  async function finishClassificationAndSync(reason) {
    if (onboardingActive() && onboardingStage() === "classify") {
      await completeOnboarding("首次视频分类已完成；以后仍可随时手动调整或重新运行 AI 分类");
    }
    await syncAfterClassificationChange(reason);
  }

  async function scan(options) {
    const settings = options || {};
    setStatus("正在同步 B站稍后再看列表...");
    try {
      const result = await send({
        type: message.SCAN_WATCHLATER,
        domItems: [],
        skipAutoClassify: Boolean(settings.skipAutoClassify)
      });
      const scanResult = result.scanResult || {};
      const autoResult = result.autoClassifyResult || {};
      await updateStateWithSyncAnimation(result, scanResult);
      setStatus(scanStatusText(scanResult, autoResult));
      return { scanResult, autoClassifyResult: autoResult };
    } catch (error) {
      setStatus("同步失败：" + error.message + "。可打开 B站稍后再看页面后用右下角入口扫描。");
      return null;
    }
  }

  function scanStatusText(scanResult, autoResult) {
    return "同步完成 · 共 " + (scanResult.scannedCount || 0) + " 个视频，新增 " + (scanResult.newCount || 0) + " 个，变化 " + (scanResult.changedCount || 0) + " 个，移除 " + (scanResult.removedCount || 0) + " 个" + (autoResult.skipped ? "；暂不分类视频" : "；完成初步分类 " + (autoResult.classified || 0) + " 个");
  }

  async function runDetails(options) {
    const settings = options || {};
    setStatus(settings.idle ? "空闲中，低频排队缺失详情..." : "正在排队缺失详情...");
    try {
      const result = await send({ type: message.FETCH_VIDEO_DETAILS });
      updateState(result);
      const output = result.detailQueueResult || {};
      if (output.disabled) {
        setStatus("详情更新已关闭");
      } else if (output.pending) {
        setStatus((settings.idle ? "空闲详情更新已启动" : "详情更新已启动") + "：缺失 " + (output.candidates || 0) + " 个，新排队 " + (output.queued || 0) + " 个，待处理 " + (output.pending || 0) + " 个");
      } else {
        setStatus("没有缺失详情的视频");
      }
      return result;
    } catch (error) {
      setStatus("详情更新失败：" + error.message);
      return null;
    }
  }

  function scheduleIdleDetailRefresh() {
    if (idleDetailTimer) clearTimeout(idleDetailTimer);
    const elapsed = lastIdleDetailRefreshAt ? Date.now() - lastIdleDetailRefreshAt : Number.POSITIVE_INFINITY;
    const wait = lastIdleDetailRefreshAt
      ? Math.max(IDLE_DETAIL_DELAY_MS, IDLE_DETAIL_INTERVAL_MS - elapsed)
      : IDLE_DETAIL_DELAY_MS;
    idleDetailTimer = setTimeout(() => {
      idleDetailTimer = 0;
      runIdleDetailRefresh();
    }, wait);
  }

  async function runIdleDetailRefresh() {
    if (llmRun.running || state.progress && state.progress.status === "running") {
      scheduleIdleDetailRefresh();
      return;
    }
    lastIdleDetailRefreshAt = Date.now();
    await runDetails({ idle: true });
    scheduleIdleDetailRefresh();
  }

  async function autoClassify(options) {
    const settings = options || {};
    if (!settings.silent) setStatus("正在进行初步分类…");
    try {
      const result = await send({
        type: message.AUTO_CLASSIFY,
        options: { silent: Boolean(settings.silent) }
      });
      updateState(result);
      const output = result.autoClassifyResult || {};
      if (!settings.silent) setStatus(keywordStatusText(output));
      return output;
    } catch (error) {
      if (!settings.silent) setStatus("初步分类失败：" + error.message);
      return null;
    }
  }

  function keywordStatusText(output) {
    if (output && output.skipped) return "首次引导中暂不分类视频";
    return "初步分类完成：写入 " + (output.classified || 0) + " 个，跳过手动确认 " + (output.skippedManual || 0) + " 个，保留已有 " + (output.unchanged || 0) + " 个";
  }

  async function exportDataBackup() {
    if (dataBackupState.running) return;
    dataBackupState = { running: true, message: "正在准备数据备份…" };
    renderEditorOnly();
    try {
      const backup = await send({ type: message.EXPORT_DATA });
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[T:]/g, "-").replace(/\.\d{3}Z$/, "Z");
      link.href = url;
      link.download = "bilibili-watch-later-backup-" + stamp + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      dataBackupState = { running: false, message: "数据备份已下载" };
      setStatus("数据备份已导出");
    } catch (error) {
      dataBackupState = { running: false, message: "导出失败：" + error.message };
      setStatus("数据备份导出失败：" + error.message);
    }
    renderEditorOnly();
  }

  async function importDataBackupFile(input) {
    const file = input && input.files && input.files[0];
    if (input) input.value = "";
    if (!file) return;

    dataBackupState = { running: true, message: "正在读取备份文件…" };
    renderEditorOnly();
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw);
      const videoCount = Array.isArray(payload.videos) ? payload.videos.length : 0;
      const classificationCount = Array.isArray(payload.classifications) ? payload.classifications.length : 0;
      const categoryCount = Array.isArray(payload.categories) ? payload.categories.length : 0;
      const confirmed = await confirmAction({
        title: "导入本地数据？",
        message: "将处理 " + videoCount + " 个视频、" + classificationCount + " 项视频分类和 " + categoryCount + " 个分类目录。现有手动确认不会被覆盖，备份中的设置（包括 API Key）也会写入本地。",
        confirmLabel: "导入备份"
      });
      if (!confirmed) {
        dataBackupState = { running: false, message: "已取消导入" };
        renderEditorOnly();
        return;
      }

      dataBackupState = { running: true, message: "正在导入本地数据…" };
      renderEditorOnly();
      const result = await send({ type: message.IMPORT_DATA, payload: raw });
      const imported = result.dataImportResult || {};
      dataBackupState = {
        running: false,
        message: "已导入 " + (imported.videos || 0) + " 个视频和 " + (imported.classifications || 0) + " 项分类" + (imported.skippedClassifications ? "，跳过 " + imported.skippedClassifications + " 项" : "")
      };
      clearDataImportDrafts();
      updateState(result);
      setStatus(dataBackupState.message + (imported.warnings && imported.warnings.length ? "；有部分记录被跳过" : ""));
    } catch (error) {
      dataBackupState = { running: false, message: "导入失败：" + error.message };
      setStatus("数据备份导入失败：" + error.message);
      renderEditorOnly();
    }
  }

  function clearDataImportDrafts() {
    categoryDraft = null;
    categoryDraftDirty = false;
    apiSettingsDraft = null;
    autoApiSettingsDraft = null;
    categoryGeneration = { running: false, message: "" };
    apiTestState = { running: false, message: "" };
  }

  function collectApiSettings() {
    return {
      llmBaseUrl: valueByRole("llm-base-url"),
      llmApiFormat: core.normalizeLlmApiFormat(valueByRole("llm-api-format")),
      llmModel: valueByRole("llm-model"),
      llmApiKey: valueByRole("llm-api-key"),
      llmTemperature: numberByRole("llm-temperature", 0.1),
      llmUseResponseFormat: checkedByRole("llm-use-response-format")
    };
  }

  function collectLlmRunSettings() {
    return {
      llmBatchSize: numberByRole("llm-batch-size", 50),
      llmLimit: numberByRole("llm-limit", 0),
      llmIncludeAll: checkedByRole("llm-include-all")
    };
  }

  function collectAutoLlmSettings() {
    return {
      llmAutoClassifyMode: valueByRole("llm-auto-classify-mode") || "off",
      llmAutoClassifyThreshold: Math.min(10000, Math.max(1, Math.floor(numberByRole("llm-auto-classify-threshold", 50))))
    };
  }

  function apiSettingsReady(config) {
    return Boolean(core.normalizeText(config && config.llmBaseUrl) && core.normalizeText(config && config.llmModel) && core.normalizeText(config && config.llmApiKey));
  }

  function openApiSettings(statusMessage) {
    settingsPanelOpen = true;
    apiSettingsOpen = true;
    renderEditorOnly();
    if (statusMessage) setStatus(statusMessage);
  }

  async function saveLlmSettings() {
    setStatus("正在保存 AI API 配置…");
    try {
      const config = collectApiSettings();
      if (!apiSettingsReady(config)) {
        setStatus("请完整填写 API URL、Model 和 API Key 后再保存");
        return;
      }
      const nextState = await send({ type: message.UPDATE_SETTINGS, settings: config });
      apiSettingsDraft = null;
      updateState(nextState);
      setStatus("已保存 AI API 配置");
    } catch (error) {
      setStatus("保存 AI API 配置失败：" + error.message);
    }
  }

  async function saveAutoLlmSettings() {
    const nextSettings = collectAutoLlmSettings();
    if (nextSettings.llmAutoClassifyMode !== "off" && !apiSettingsReady(state.settings || {})) {
      openApiSettings("启用自动 API 视频分类前，请先在“API 设置”中填写、保存并测试 API");
      return;
    }
    setStatus("正在保存自动 API 视频分类设置…");
    try {
      const nextState = await send({ type: message.UPDATE_SETTINGS, settings: nextSettings });
      autoApiSettingsDraft = null;
      updateState(nextState);
      const labels = { off: "关闭", daily: "每天", weekly: "每周", threshold: "按待精细分类数量" };
      setStatus("已保存自动 API 视频分类设置：" + (labels[nextSettings.llmAutoClassifyMode] || "关闭"));
    } catch (error) {
      setStatus("保存自动 API 视频分类设置失败：" + error.message);
    }
  }

  async function testLlmApi() {
    if (apiTestState.running) return;
    const config = collectApiSettings();
    if (!apiSettingsReady(config)) {
      apiTestState = { running: false, message: "请先完整填写 API URL、Model 和 API Key。" };
      renderEditorOnly();
      setStatus("API 尚未设置完整，请先填写必填项");
      return;
    }
    apiSettingsDraft = config;
    apiTestState = { running: true, message: "正在发送最小测试请求…" };
    renderEditorOnly();
    try {
      const response = await sendLlmRequest(config, "请只回复一个简短的 JSON 对象：{\"ok\":true}", false, 30000);
      const textValue = await response.text();
      if (!response.ok) throw new Error("HTTP " + response.status + ": " + textValue.slice(0, 240));
      const data = parseJsonObject(textValue);
      const content = core.extractLlmText(data);
      if (!core.normalizeText(content)) throw new Error("响应缺少可读取的文本内容");
      apiTestState = { running: false, message: "测试通过。当前 API 可以正常响应；如有修改，请点击“保存 API 设置”。" };
      setStatus("API 测试通过");
    } catch (error) {
      apiTestState = { running: false, message: "测试失败：" + error.message + "。请检查地址、模型、密钥或服务余额。" };
      setStatus("API 测试失败：" + error.message + "；请先在“设置”中修正 API");
    } finally {
      renderEditorOnly();
    }
  }

  function stopLlmRun() {
    if (!llmRun.running) return;
    llmRun.stopRequested = true;
    llmRun.message = "正在停止，当前批次完成后退出";
    renderEditorOnly();
  }

  async function startLlmRun() {
    if (llmRun.running) return;
    const config = Object.assign({}, state.settings || {}, collectLlmRunSettings());
    if (!apiSettingsReady(config)) {
      openApiSettings("API 尚未设置完整，请先在“设置”中填写、保存并测试 API");
      return;
    }

    llmRun = {
      running: true,
      stopRequested: false,
      done: false,
      imported: 0,
      skipped: 0,
      processed: 0,
      total: 0,
      message: "正在保存配置...",
      batches: [],
      warnings: []
    };
    llmPanelOpen = true;
    renderEditorOnly();

    try {
      updateState(await send({ type: message.UPDATE_SETTINGS, settings: config }));
      await runLlmBatches(config);
      llmRun.done = true;
      const failed = failedBatchCount();
      llmRun.message = llmRun.stopRequested ? "已停止" : failed ? "API 分类有 " + failed + " 个批次失败" : "AI (API) 批量视频分类完成";
      updateState(await send({ type: message.GET_STATE }));
      if (llmRun.imported) await finishClassificationAndSync("AI (API) 批量视频分类已更新");
      if (failed) {
        settingsPanelOpen = true;
        apiSettingsOpen = true;
        setStatus(llmRun.message + "：导入 " + llmRun.imported + " 项；请先在“设置”中检查并测试 API");
      } else {
        setStatus(llmRun.message + "：导入 " + llmRun.imported + " 项，跳过 " + llmRun.skipped + " 项");
      }
    } catch (error) {
      llmRun.message = "AI (API) 批量视频分类失败：" + error.message;
      settingsPanelOpen = true;
      apiSettingsOpen = true;
      setStatus(llmRun.message + "；请先在“设置”中检查并测试 API");
    } finally {
      llmRun.running = false;
      renderEditorOnly();
    }
  }

  async function runLlmBatches(config) {
    const batchSize = Math.min(100, Math.max(1, Number(config.llmBatchSize) || 50));
    const limit = Math.max(0, Number(config.llmLimit) || 0);
    const includeAll = Boolean(config.llmIncludeAll);
    let offset = 0;
    while (!llmRun.stopRequested) {
      const remaining = limit ? Math.max(0, limit - llmRun.processed) : batchSize;
      if (limit && remaining <= 0) break;
      const requested = limit ? Math.min(batchSize, remaining) : batchSize;
      llmRun.message = "正在导出第 " + (llmRun.batches.length + 1) + " 批...";
      renderEditorOnly();
      const exported = await send({
        type: message.EXPORT_AI_CLASSIFY_BATCH,
        includeAll,
        limit: requested,
        offset
      });
      if (!exported.batchSize) break;
      llmRun.total = limit ? Math.min(limit, exported.totalCandidates || 0) : (exported.totalCandidates || 0);
      const batch = {
        index: llmRun.batches.length + 1,
        size: exported.batchSize,
        status: "calling"
      };
      llmRun.batches.push(batch);
      llmRun.message = "正在调用 AI：第 " + batch.index + " 批，" + batch.size + " 个视频";
      renderEditorOnly();

      try {
        const payload = normalizeLlmPayload(await callLlm(config, exported.prompt || ""));
        batch.llmItems = payload.items.length;
        if (payload.items.length < batch.size) {
          const warning = "第 " + batch.index + " 批 AI 返回 " + payload.items.length + " 项，少于导出 " + batch.size + " 个视频";
          llmRun.warnings.push(warning);
          batch.warning = warning;
        }
        batch.status = "importing";
        llmRun.message = "正在导入第 " + batch.index + " 批...";
        renderEditorOnly();
        const importedState = await send({
          type: message.IMPORT_AI_CLASSIFICATIONS,
          payload: JSON.stringify(payload),
          options: { mergeMode: "replace", batchBvids: exported.batchBvids }
        });
        const importResult = importedState.importResult || {};
        batch.status = "done";
        batch.imported = importResult.imported || 0;
        batch.skipped = importResult.skipped || 0;
        batch.warnings = importResult.warnings || [];
        updateState(importedState);
        llmRun.imported += batch.imported;
        llmRun.skipped += batch.skipped;
        llmRun.warnings.push(...batch.warnings);
        if (includeAll) offset += exported.batchSize || 0;
        llmRun.message = "已完成第 " + batch.index + " 批";
      } catch (error) {
        batch.status = "failed";
        batch.error = error.message;
        llmRun.warnings.push("第 " + batch.index + " 批失败：" + error.message);
        offset += exported.batchSize || 0;
        llmRun.message = "第 " + batch.index + " 批失败，已跳过继续";
      }
      llmRun.processed += exported.batchSize || 0;
      renderEditorOnly();
    }
  }

  async function callLlm(config, prompt) {
    const requestPrompt = [
      prompt,
      "",
      "重要：必须为本批待分类视频中的每一个 bvid 返回一项。不要漏掉视频；信息不足时用 other.todo。",
      "返回必须是严格 JSON 对象：所有属性名和字符串都必须使用双引号，顶层必须是 {\"items\":[...]}。"
    ].join("\n");
    const useResponseFormat = config.llmUseResponseFormat === true;
    let response = await sendLlmRequest(config, requestPrompt, useResponseFormat);
    let textValue = await response.text();
    if (!response.ok && useResponseFormat && /response[_ ]format|text\.format|json_object/i.test(textValue)) {
      llmRun.warnings.push("当前模型不支持结构化 JSON 输出，已自动重试普通 JSON 提示模式");
      response = await sendLlmRequest(config, requestPrompt, false);
      textValue = await response.text();
    }
    if (!response.ok) {
      throw new Error("AI API HTTP " + response.status + ": " + textValue.slice(0, 300));
    }
    const data = parseJsonObject(textValue);
    const content = core.extractLlmText(data);
    if (!content) throw new Error("AI 响应缺少可读取的文本内容");
    return parseJsonObject(content);
  }

  async function callCategoryLlm(config, prompt) {
    const requestPrompt = [
      prompt,
      "",
      "再次确认：本次只生成分类目录，不要返回任何 bvid 的视频分类结果。",
      "顶层必须是 {\"categories\":[...]}，每项必须包含 id、name、parentId、order、keywords。"
    ].join("\n");
    const useResponseFormat = config.llmUseResponseFormat === true;
    let response = await sendLlmRequest(config, requestPrompt, useResponseFormat);
    let textValue = await response.text();
    if (!response.ok && useResponseFormat && /response[_ ]format|text\.format|json_object/i.test(textValue)) {
      if (onboardingCategoryRunning) onboardingCategoryMessage = "模型不支持结构化 JSON 输出，正在用普通 JSON 模式重试…";
      if (categoryGeneration.running) categoryGeneration.message = "模型不支持结构化 JSON 输出，正在用普通 JSON 模式重试…";
      renderShell();
      response = await sendLlmRequest(config, requestPrompt, false);
      textValue = await response.text();
    }
    if (!response.ok) {
      throw new Error("AI API HTTP " + response.status + ": " + textValue.slice(0, 300));
    }
    const data = parseJsonObject(textValue);
    const content = core.extractLlmText(data);
    if (!content) throw new Error("AI 响应缺少可读取的文本内容");
    const payload = parseJsonObject(content);
    if (!Array.isArray(payload && payload.categories) || !payload.categories.length) {
      throw new Error("AI 返回中没有 categories 数组");
    }
    return payload;
  }

  async function sendLlmRequest(config, requestPrompt, useResponseFormat, timeoutMs) {
    const body = core.buildLlmRequestBody(config, requestPrompt, useResponseFormat);
    return fetchWithTimeout(core.llmApiUrl(config.llmBaseUrl, config.llmApiFormat), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + config.llmApiKey,
        "x-title": "Bili Watchlater Classifier"
      },
      body: JSON.stringify(body)
    }, timeoutMs || 120000);
  }

  function normalizeLlmPayload(payload) {
    const items = Array.isArray(payload && payload.items)
      ? payload.items
      : Array.isArray(payload && payload.classifications)
        ? payload.classifications
        : [];
    if (!items.length) throw new Error("AI 返回的 JSON 没有 items/classifications 数组");
    return { items };
  }

  function parseJsonObject(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("JSON 内容为空");
    const candidate = jsonCandidate(raw);
    try {
      return JSON.parse(candidate);
    } catch (error) {
      const repaired = repairLooseJson(candidate);
      try {
        return JSON.parse(repaired);
      } catch (repairError) {
        throw new Error("AI 返回的内容不是严格 JSON：" + repairError.message + "；片段：" + candidate.slice(0, 180));
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
      return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function chatCompletionsUrl(value) {
    return core.llmApiUrl(value, core.LLM_API_FORMATS.CHAT_COMPLETIONS);
  }

  async function generateCategoriesWithApi() {
    if (categoryGeneration.running) return;
    const config = Object.assign({}, state.settings || {});
    if (!apiSettingsReady(config)) {
      openApiSettings("API 尚未设置完整，请先在“设置”中填写、保存并测试 API");
      return;
    }
    categoryGeneration.running = true;
    categoryGeneration.message = "正在读取现有视频信息…";
    renderEditorOnly();
    try {
      const exported = await send({ type: message.EXPORT_CATEGORY_PROPOSAL });
      categoryGeneration.message = "已准备 " + (exported.sampleCount || 0) + " 个视频的信息，正在请求 AI 生成分类目录…";
      renderEditorOnly();
      const payload = await callCategoryLlm(config, exported.prompt || "");
      categoryGeneration.running = false;
      await confirmAndImportCategories(payload, "api", "API");
    } catch (error) {
      categoryGeneration.running = false;
      categoryGeneration.message = "API 生成分类目录失败：" + error.message;
      settingsPanelOpen = true;
      apiSettingsOpen = true;
      setStatus(categoryGeneration.message + "；请先在“设置”中检查并测试 API");
      renderEditorOnly();
    }
  }

  async function confirmAndImportCategories(payload, source, sourceLabel) {
    const count = Array.isArray(payload && payload.categories) ? payload.categories.length : 0;
    if (!count) throw new Error("AI 返回中没有 categories 数组");
    const confirmed = await confirmAction({
      title: "替换分类目录？",
      message: "将使用 AI 生成的 " + count + " 项分类替换当前分类目录。这不是在给已有视频重新分类，手动确认的视频分类不会被覆盖。",
      confirmLabel: "确认替换"
    });
    if (!confirmed) {
      categoryGeneration.message = "已取消替换分类目录。";
      setStatus(categoryGeneration.message);
      renderEditorOnly();
      return false;
    }
    setStatus("正在导入并替换分类目录…");
    const result = await send({
      type: message.IMPORT_CATEGORIES,
      payload,
      source,
      skipAutoClassify: onboardingActive()
    });
    categoryDraft = null;
    categoryDraftDirty = false;
    categoryGeneration.message = sourceLabel + " 已生成新的分类目录。";
    if (onboardingActive()) {
      await handleOnboardingCategoryImport(result, sourceLabel);
    } else {
      updateState(result);
      await syncAfterCategoryListChange("分类目录已替换");
      const imported = result.categoryImportResult || {};
      setStatus(sourceLabel + " 已替换分类目录：" + (imported.imported || state.categories.length) + " 项；手动确认的视频分类未改变");
    }
    return true;
  }

  function addCategory() {
    harvestCategoryDraft();
    const parent = document.querySelector('[data-role="new-category-parent"]');
    const input = document.querySelector('[data-role="new-category-name"]');
    const name = core.normalizeText(input ? input.value : "");
    if (!core.normalizeText(name)) {
      setStatus("请输入新分类名称");
      return;
    }
    const draft = ensureCategoryDraft();
    const parentId = parent ? parent.value : "";
    const id = core.categoryIdFromName(parentId, name, draft);
    const siblings = draft.filter((category) => (category.parentId || "") === parentId);
    const order = siblings.reduce((max, category) => Math.max(max, Number(category.order) || 0), 0) + 10;
    draft.push({ id, name, parentId: parentId || undefined, order, keywords: [], enabled: true });
    categoryDraftDirty = true;
    setStatus("已加入分类草稿：" + name + "；点击“确定保存”后生效");
    renderEditorOnly();
  }

  async function deleteCategory(categoryId) {
    harvestCategoryDraft();
    const draft = ensureCategoryDraft();
    const category = draft.find((item) => item.id === categoryId);
    const label = category ? categoryLabel(category) : categoryId;
    const confirmed = await confirmAction({
      title: "删除分类？",
      message: "将从草稿中删除「" + label + "」及其子分类，保存分类目录后才会生效。",
      confirmLabel: "删除"
    });
    if (!confirmed) return;
    const removeIds = new Set(core.descendantsOf(categoryId, draft));
    categoryDraft = draft.filter((item) => !removeIds.has(item.id));
    categoryDraftDirty = true;
    setStatus("已从草稿删除分类：" + label + "；尚未保存");
    renderEditorOnly();
  }

  async function saveCategoryDraft() {
    harvestCategoryDraft();
    const categories = ensureCategoryDraft();
    if (!categories.length) {
      setStatus("至少保留一个分类");
      return;
    }
    setStatus("正在保存分类并判定新增分类...");
    try {
      const result = await send({
        type: message.SAVE_CATEGORIES,
        categories,
        skipAutoClassify: onboardingActive() && onboardingStage() === "setup-categories"
      });
      const saved = result.categorySaveResult || {};
      const keyword = saved.keywordResult || {};
      if (activeFilter.categoryIds.some((id) => (saved.removedCategoryIds || []).includes(id))) {
        activeFilter = emptyFilterWithDuration();
      }
      categoryDraft = null;
      categoryDraftDirty = false;
      updateState(result);
      const keywordText = keyword.skipped
        ? "首次引导阶段暂不判定视频"
        : "已对全部 " + (keyword.checked || 0) + " 个视频进行新增目录的初步分类（包括手动确认和 AI 分类），命中 " + (keyword.matchedVideos || 0) + " 个视频";
      setStatus("分类目录已保存；" + keywordText + "。如需对视频进行细分类，可使用 AI (API) 批量视频分类。" );
    } catch (error) {
      setStatus("分类保存失败：" + error.message);
    }
  }

  function discardCategoryDraft() {
    categoryDraft = null;
    categoryDraftDirty = false;
    setStatus("已放弃未保存的分类修改");
    renderEditorOnly();
  }

  function ensureCategoryDraft() {
    if (!categoryDraft) {
      categoryDraft = state.categories
        .filter((category) => category.enabled !== false)
        .map((category) => Object.assign({}, category, { keywords: core.uniqueStrings(category.keywords) }));
    }
    return categoryDraft;
  }

  function harvestCategoryDraft() {
    if (!categoryDraft) return;
    categoryDraft.forEach((category) => {
      const nameInput = findByRoleAndCategory("category-name", category.id);
      const parentSelect = findByRoleAndCategory("category-parent", category.id);
      if (nameInput) category.name = nameInput.value;
      if (parentSelect) category.parentId = parentSelect.value || undefined;
    });
  }

  async function removeFromWatchlater(bvid) {
    const video = state.videos.find((item) => item.bvid === bvid);
    if (!video) return;
    const confirmed = await confirmAction({
      title: "移出稍后再看？",
      message: "「" + core.truncateText(video.title || bvid, 58) + "」\n本地分类记录会保留。",
      confirmLabel: "移出"
    });
    if (!confirmed) return;
    setStatus("正在从稍后再看移除：" + bvid);
    try {
      const result = await send({
        type: message.REMOVE_FROM_WATCHLATER,
        bvid
      });
      updateState(result);
      if (selectedBvid === bvid) {
        const first = visibleVideos()[0] || presentVideos()[0];
        selectedBvid = first ? first.bvid : "";
        renderShell();
      }
      setStatus("已移出稍后再看：" + bvid);
    } catch (error) {
      setStatus("移出稍后失败：" + error.message);
    }
  }

  async function saveManualClassification(bvid) {
    const categoryIds = Array.from(document.querySelectorAll('[data-role="manual-category"]:checked')).map((item) => item.value);
    setStatus("正在保存手动确认…");
    try {
      updateState(await send({
        type: message.SAVE_MANUAL_CLASSIFICATION,
        bvid,
        categoryIds
      }));
      setStatus("已保存手动确认：" + bvid);
      await finishClassificationAndSync("手动确认已保存");
    } catch (error) {
      setStatus("保存失败：" + error.message);
    }
  }

  function visibleVideos() {
    const classifications = classificationMap();
    const query = core.normalizeText(searchText).toLowerCase();
    const currentVideos = presentVideos();
    return currentVideos
      .filter((video) => core.matchesFilter(video, classifications.get(video.bvid), activeFilter, currentVideos))
      .filter((video) => {
        if (!query) return true;
        const haystack = [
          video.bvid,
          video.title,
          video.upName,
          video.tname,
          (video.tags || []).join(" "),
          video.desc
        ].join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .sort(compareVideos);
  }

  function compareVideos(a, b) {
    const mode = state.settings.sortMode || "watchlater";
    const desc = (state.settings.sortDirection || "desc") === "desc";
    if (mode === "pubdate") {
      return compareNumber(a.pubdate, b.pubdate, desc) || compareWatchlaterOrder(a, b);
    }
    if (mode === "duration") {
      return compareNumber(a.duration, b.duration, desc) || compareWatchlaterOrder(a, b);
    }
    return compareWatchlaterOrder(a, b, desc);
  }

  function compareWatchlaterOrder(a, b, desc) {
    const newestFirst = desc !== false;
    const aOrder = Number.isFinite(Number(a.watchlaterOrder)) ? Number(a.watchlaterOrder) : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(Number(b.watchlaterOrder)) ? Number(b.watchlaterOrder) : Number.POSITIVE_INFINITY;
    return (newestFirst ? aOrder - bOrder : bOrder - aOrder) ||
      compareNumber(a.watchlaterAddedAt, b.watchlaterAddedAt, newestFirst) ||
      compareNumber(a.firstSeenAt, b.firstSeenAt, newestFirst) ||
      compareNumber(a.lastSeenAt, b.lastSeenAt, newestFirst) ||
      (a.title || "").localeCompare(b.title || "");
  }

  function compareNumber(a, b, desc) {
    const left = Number(a) || 0;
    const right = Number(b) || 0;
    return desc ? right - left : left - right;
  }

  function presentVideos() {
    return (state.videos || []).filter((video) => video.presentInWatchlater !== false);
  }

  function classificationMap() {
    return new Map((state.classifications || []).map((item) => [item.bvid, item]));
  }

  function categoryCounts() {
    const byCategory = new Map();
    const categories = state.categories || [];
    const classifications = classificationMap();
    let unclassified = 0;
    presentVideos().forEach((video) => {
      const classification = classifications.get(video.bvid);
      if (core.needsLlmExport(video, classification)) {
        unclassified += 1;
      }
      (classification && classification.categoryIds || []).forEach((categoryId) => {
        let current = categories.find((category) => category.id === categoryId);
        while (current) {
          byCategory.set(current.id, (byCategory.get(current.id) || 0) + 1);
          current = current.parentId ? categories.find((category) => category.id === current.parentId) : null;
        }
      });
    });
    return { byCategory, unclassified };
  }

  function sourceTypeCounts() {
    const counts = { manual: 0, llm: 0, keyword: 0 };
    const classifications = classificationMap();
    presentVideos().forEach((video) => {
      const sourceType = core.classificationSourceType(classifications.get(video.bvid));
      if (sourceType && Object.prototype.hasOwnProperty.call(counts, sourceType)) {
        counts[sourceType] += 1;
      }
    });
    return counts;
  }

  function countUnclassified() {
    const classifications = classificationMap();
    return presentVideos().filter((video) => !classifications.has(video.bvid)).length;
  }

  function countNeedsClassification() {
    const classifications = classificationMap();
    return presentVideos().filter((video) => core.needsLlmExport(video, classifications.get(video.bvid))).length;
  }

  function expandCategoryIds(categoryIds) {
    const expanded = new Set();
    (categoryIds || []).forEach((categoryId) => {
      core.descendantsOf(categoryId, state.categories).forEach((id) => expanded.add(id));
    });
    return Array.from(expanded);
  }

  function collapsedCategoryIds() {
    return core.normalizeCollapsedCategoryIds(state.settings && state.settings.collapsedCategoryIds);
  }

  function isCategoryCollapsed(categoryId) {
    return collapsedCategoryIds().includes(categoryId);
  }

  function categoryLabel(category) {
    return core.categoryPath(category, core.categoryById(state.categories)) || category.name || category.id;
  }

  function categoryNames(classification) {
    const byId = core.categoryById(state.categories);
    return ((classification && classification.categoryIds) || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((category) => core.categoryPath(category, byId) || category.name);
  }

  function flattenCategoriesInTree(categories) {
    const rows = [];
    appendCategoryRows(rows, "", 0, categories || state.categories);
    return rows;
  }

  function appendCategoryRows(rows, parentId, level, categories) {
    core.childrenOf(categories, parentId).forEach((category) => {
      rows.push({ category, level });
      appendCategoryRows(rows, category.id, level + 1, categories);
    });
  }

  function categoryTreeLabel(category, level) {
    const prefix = level ? "　".repeat(level) + "└ " : "";
    return prefix + (category.name || category.id);
  }

  function categoryBadgeNodes(classification) {
    const byId = core.categoryById(state.categories);
    return ((classification && classification.categoryIds) || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((category) => el("span", {
        className: "badge",
        style: categoryStyle(category, "badge"),
        title: core.categoryPath(category, byId) || category.name,
        textContent: category.name || category.id
      }));
  }

  function activeFilterLabel() {
    const labels = [];
    if (activeFilter.includeUnclassified) labels.push("待精细分类");
    if (activeFilter.upGroupKey) {
      const group = core.upGroups(presentVideos()).find((item) => item.key === activeFilter.upGroupKey);
      labels.push("UP 主 · " + (group ? group.name : "未知 UP 主"));
    }
    if (activeFilter.categoryIds.length) {
      const ids = activeFilter.sourceCategoryId ? [activeFilter.sourceCategoryId] : activeFilter.categoryIds;
      const names = ids
        .map((id) => state.categories.find((category) => category.id === id))
        .filter(Boolean)
        .map((category) => category.name);
      if (names.length) labels.push(names.slice(0, 3).join("、") + (names.length > 3 ? " 等" : ""));
    }
    const durationLabel = activeDurationFilterLabel();
    if (durationLabel) labels.push("视频时长 · " + durationLabel);
    const watchProgressLabel = activeWatchProgressFilterLabel();
    if (watchProgressLabel) labels.push("观看进度 · " + watchProgressLabel);
    return labels.length ? "筛选：" + labels.join(" · ") : "筛选：全部";
  }

  function activeWatchProgressFilterLabel() {
    const presets = core.WATCH_PROGRESS_FILTER_PRESETS;
    const preset = core.normalizeWatchProgressFilterPreset(activeFilter.watchProgressPreset);
    if (preset === presets.ALL) return "";
    if (preset === presets.NOT_STARTED) return "未开始";
    if (preset === presets.IN_PROGRESS) return "观看中";
    if (preset === presets.COMPLETED) return "已看完";
    return "";
  }

  function activeDurationFilterLabel() {
    const presets = core.DURATION_FILTER_PRESETS;
    const preset = core.normalizeDurationFilterPreset(activeFilter.durationPreset);
    if (preset === presets.ALL) return "";
    if (preset === presets.UNKNOWN) return "时长未知";
    if (preset === presets.UNDER_10) return "少于 10 分钟";
    if (preset === presets.FROM_10_TO_30) return "10-30 分钟";
    if (preset === presets.FROM_30_TO_60) return "30-60 分钟";
    if (preset === presets.OVER_60) return "60 分钟以上";
    const minimum = activeFilter.durationMin == null || activeFilter.durationMin === "" ? "" : String(activeFilter.durationMin);
    const maximum = activeFilter.durationMax == null || activeFilter.durationMax === "" ? "" : String(activeFilter.durationMax);
    if (!minimum && !maximum) return "自定义范围";
    return (minimum || "不限") + " 至 " + (maximum || "不限") + " 分钟";
  }

  function applyCustomDurationFilter() {
    const minimum = readDurationBound(document.querySelector('[data-role="duration-min"]'));
    const maximum = readDurationBound(document.querySelector('[data-role="duration-max"]'));
    if (minimum === null || maximum === null) {
      setStatus("自定义时长必须是 0 或更大的数字");
      return;
    }
    if (minimum !== "" && maximum !== "" && minimum > maximum) {
      setStatus("最短时长不能大于最长时长");
      return;
    }
    activeFilter = Object.assign({}, activeFilter, {
      durationPreset: core.DURATION_FILTER_PRESETS.CUSTOM,
      durationMin: minimum,
      durationMax: maximum
    });
    renderShell();
  }

  function readDurationBound(input) {
    const value = input && input.value != null ? String(input.value).trim() : "";
    if (!value) return "";
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function statusText() {
    if (statusNotice.text) return statusNotice.text;
    if (state.progress && state.progress.message) {
      return state.progress.message + (state.progress.pending ? " · 待处理 " + state.progress.pending : "");
    }
    return "同步完成 · 共 " + presentVideos().length + " 个视频";
  }

  function setStatus(textValue) {
    statusNotice = { text: textValue || "", kind: statusKind(textValue) };
    updateStatusSurface();
  }

  function updateStatusSurface() {
    const textValue = statusText();
    const kind = statusNotice.text ? statusNotice.kind : statusKind(textValue);
    const surface = document.querySelector('[data-role="status-surface"]');
    const node = document.querySelector('[data-role="status"]');
    const icon = document.querySelector('[data-role="status-icon"]');
    if (node) node.textContent = textValue;
    if (surface) surface.className = "activity-status status-" + kind;
    if (icon) icon.replaceChildren(statusIcon(kind));
  }

  function statusKind(textValue) {
    const value = String(textValue || "");
    if (/失败|错误|无法|缺少|未登录|不可用|超时/.test(value)) return "error";
    if (/正在|排队|请等待|启动中|处理中|更新中/.test(value)) return "running";
    if (/完成|成功|已同步|已保存|已移出|已生成|已复制|已导入|没有缺失/.test(value)) return "success";
    return "info";
  }

  function coverNode(video, className) {
    if (video && video.coverUrl) {
      return el("img", { className, src: video.coverUrl, alt: "" });
    }
    return el("div", { className: className + " placeholder", textContent: "无封面" });
  }

  function renderCover(video) {
    const watchProgress = videoWatchProgress(video);
    const duration = Number(video && video.duration) || 0;
    const progressPercent = duration > 0 && watchProgress > 0 ? Math.min(100, watchProgress / duration * 100) : 0;
    return el("div", { className: "cover-wrap" }, [
      coverNode(video, "cover"),
      duration ? el("span", {
        className: "duration-badge",
        textContent: watchProgress > 0 ? formatDuration(watchProgress) + "/" + formatDuration(duration) : formatDuration(duration)
      }) : null,
      progressPercent > 0 ? el("span", { className: "watch-progress", "aria-hidden": "true" }, [
        el("span", { className: "watch-progress-value", style: "width:" + progressPercent.toFixed(2) + "%;" })
      ]) : null
    ].filter(Boolean));
  }

  function renderMetricStats(video) {
    const stats = metricDefinitions().map(([field, label, className, icon]) => {
      const value = field === "likeRate" ? likeRateValue(video) : video && video[field];
      if (!hasMetricCount(value)) return null;
      const formatted = field === "likeRate" ? formatLikeRate(value) : formatMetricCount(value);
      return el("span", {
        className: "card-stat " + className,
        title: label,
        "aria-label": label + " " + formatted
      }, [
        iconNode(icon),
        el("span", { textContent: formatted })
      ]);
    }).filter(Boolean);
    return stats.length ? el("div", { className: "card-stats" }, stats) : null;
  }

  function metricDefinitions() {
    return [
      ["viewCount", "播放量", "view-count-badge", "play"],
      ["likeCount", "点赞数", "like-count-badge", "heart"],
      ["replyCount", "评论数", "reply-count-badge", "comment"],
      ["favoriteCount", "收藏数", "favorite-count-badge", "star"],
      ["coinCount", "投币数", "coin-count-badge", "coin"],
      ["danmakuCount", "弹幕数", "danmaku-count-badge", "message"],
      ["shareCount", "转发数", "share-count-badge", "share"],
      ["likeRate", "点赞率", "like-rate-badge", "percent"]
    ];
  }

  function hasMetricCount(value) {
    return value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
  }

  function likeRateValue(video) {
    const viewCount = Number(video && video.viewCount);
    const likeCount = video && video.likeCount;
    if (!Number.isFinite(viewCount) || viewCount <= 0 || !hasMetricCount(likeCount)) return null;
    return Number(likeCount) / viewCount * 100;
  }

  function videoWatchProgress(video) {
    const duration = Number(video && video.duration) || 0;
    if (video && video.isWatched && duration > 0) return duration;
    const progress = Number(video && video.watchProgress);
    if (!Number.isFinite(progress) || progress <= 0) return 0;
    return duration > 0 ? Math.min(progress, duration) : progress;
  }

  function formatMetricCount(value) {
    const count = Math.max(0, Number(value) || 0);
    if (count >= 100000000) return trimCount(count / 100000000) + "亿";
    if (count >= 10000) return trimCount(count / 10000) + "万";
    return Math.floor(count).toLocaleString("zh-CN");
  }

  function formatLikeRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0) return "";
    if (rate > 0 && rate < 0.1) return "<0.1%";
    return rate.toFixed(1).replace(/\.0$/, "") + "%";
  }

  function trimCount(value) {
    return value >= 100 ? String(Math.floor(value)) : value.toFixed(1).replace(/\.0$/, "");
  }

  function statusLabel(status) {
    const labels = {
      unclassified: "分类异常",
      stale: "建议重新分类",
      low_confidence: "结果不确定",
      manual: "手动确认",
      llm: "AI 分类",
      keyword: "初步分类",
      classified: "已分类"
    };
    return labels[status] || status || "分类异常";
  }

  function sourceLabel(sourceType) {
    const labels = {
      manual: "手动确认",
      llm: "AI 分类",
      keyword: "初步分类"
    };
    return labels[sourceType] || sourceType || "";
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return "";
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    const rest = Math.floor(value % 60);
    return hours > 0
      ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0")
      : minutes + ":" + String(rest).padStart(2, "0");
  }

  function formatDate(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return "";
    const ms = value < 100000000000 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "";
    return "发布 " + date.toLocaleDateString("zh-CN");
  }

  function formatSettingsTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return "尚未运行";
    const date = new Date(value < 100000000000 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return "尚未运行";
    return date.toLocaleString("zh-CN");
  }

  function formatWatchlaterDate(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return "";
    const ms = value < 100000000000 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "";
    return "添加 " + date.toLocaleDateString("zh-CN");
  }

  function sortOptions() {
    const current = sortComboValue();
    return [
      option("watchlater:desc", "添加时间-降序", current),
      option("watchlater:asc", "添加时间-升序", current),
      option("pubdate:desc", "发布时间-降序", current),
      option("pubdate:asc", "发布时间-升序", current),
      option("duration:desc", "视频时长-降序", current),
      option("duration:asc", "视频时长-升序", current)
    ];
  }

  function sortComboValue() {
    const mode = ["watchlater", "pubdate", "duration"].includes(state.settings.sortMode) ? state.settings.sortMode : "watchlater";
    const direction = state.settings.sortDirection === "asc" ? "asc" : "desc";
    return mode + ":" + direction;
  }

  function parseSortCombo(value) {
    const parts = String(value || "").split(":");
    const sortMode = ["watchlater", "pubdate", "duration"].includes(parts[0]) ? parts[0] : "watchlater";
    const sortDirection = parts[1] === "asc" ? "asc" : "desc";
    return { sortMode, sortDirection };
  }

  function option(value, label, current) {
    return el("option", { value, textContent: label, selected: value === current });
  }

  function renderCategoryAdminRow(category, level, categories) {
    const descendants = new Set(core.descendantsOf(category.id, categories));
    const options = [el("option", {
      value: "",
      textContent: "一级分类",
      selected: !category.parentId
    })].concat(flattenCategoriesInTree(categories)
      .filter((row) => row.category.id !== category.id && !descendants.has(row.category.id))
      .map((row) => el("option", {
        value: row.category.id,
        textContent: categoryTreeLabel(row.category, row.level),
        selected: (category.parentId || "") === row.category.id
      })));
    return el("div", {
      className: "category-admin-row",
      style: "--admin-indent:" + (Math.min(level || 0, 4) * 12) + "px;"
    }, [
      el("span", { className: "swatch", style: categoryStyle(category, "swatch") }),
      el("div", { className: "category-admin-fields" }, [
        el("input", { type: "text", value: category.name, dataset: { role: "category-name", categoryId: category.id } }),
        el("select", { dataset: { role: "category-parent", categoryId: category.id } }, options)
      ]),
      el("div", { className: "category-admin-actions" }, [
        el("button", { className: "danger", dataset: { action: "delete-category", categoryId: category.id }, textContent: "删除" })
      ])
    ]);
  }

  function findByRoleAndCategory(role, categoryId) {
    return Array.from(document.querySelectorAll('[data-role="' + role + '"]'))
      .find((node) => node.dataset.categoryId === categoryId);
  }

  function nodeByRole(role) {
    return document.querySelector('[data-role="' + role + '"]');
  }

  function valueByRole(role) {
    const node = nodeByRole(role);
    return node ? node.value : "";
  }

  function numberByRole(role, fallback) {
    const number = Number(valueByRole(role));
    return Number.isFinite(number) ? number : fallback;
  }

  function checkedByRole(role) {
    const node = nodeByRole(role);
    return Boolean(node && node.checked);
  }

  function categoryStyle(category, kind) {
    const color = categoryColor(category);
    if (kind === "swatch") return "background:" + color.accent + ";";
    if (kind === "row") return "--cat-bg:" + color.bg + ";--cat-border:" + color.border + ";--cat-text:" + color.text + ";--cat-accent:" + color.accent + ";";
    if (kind === "badge") return "background:" + color.bg + ";border-color:" + color.border + ";color:" + color.text + ";";
    if (kind === "option") return "background:" + color.bg + ";color:" + color.text + ";";
    return "";
  }

  function categoryColor(category) {
    return core.categoryColorTokens(state.categories, category);
  }

  function rememberScrollPositions() {
    const categoryNav = document.querySelector(".cat-nav");
    const main = document.querySelector(".main");
    const editor = document.querySelector(".editor");
    if (categoryNav) savedCategoryScrollTop = categoryNav.scrollTop;
    if (main) savedMainScrollTop = main.scrollTop;
    if (editor) savedEditorScrollTop = editor.scrollTop;
  }

  function restoreScrollPositions() {
    const categoryNav = document.querySelector(".cat-nav");
    const main = document.querySelector(".main");
    const editor = document.querySelector(".editor");
    if (categoryNav) categoryNav.scrollTop = savedCategoryScrollTop;
    if (main) main.scrollTop = savedMainScrollTop;
    if (editor) editor.scrollTop = savedEditorScrollTop;
  }

  function toolbarIconButton(action, label, iconName) {
    return el("button", {
      className: "ghost toolbar-icon-button",
      title: label,
      "aria-label": label,
      dataset: { action }
    }, [iconNode(iconName)]);
  }

  function statusIcon(kind) {
    return iconNode(kind === "running" ? "spinner" : kind);
  }

  function iconNode(name) {
    const svg = svgNode("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      focusable: "false"
    });
    const commonStroke = {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    };
    const shapes = {
      bilibili: [
        ["path", Object.assign({ d: "M8.2 4 10 6.2h4L15.8 4M5.2 7.1h13.6a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2V9.1a2 2 0 0 1 2-2Z" }, commonStroke)],
        ["path", Object.assign({ d: "M8 12v2.2M16 12v2.2" }, commonStroke)]
      ],
      watchlater: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "8.5" }, commonStroke)],
        ["path", Object.assign({ d: "M12 7.5v5l3.2 1.8" }, commonStroke)]
      ],
      dynamic: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "2.2" }, commonStroke)],
        ["path", Object.assign({ d: "M12 3.5a8.5 8.5 0 0 1 8.5 8.5M3.5 12A8.5 8.5 0 0 1 12 3.5M12 20.5A8.5 8.5 0 0 1 3.5 12" }, commonStroke)],
        ["circle", { cx: "20.5", cy: "12", r: "1.3", fill: "currentColor" }]
      ],
      trash: [
        ["path", Object.assign({ d: "M5.5 7h13M9.3 7V4.8h5.4V7M7.5 7l.8 12h7.4l.8-12M10.2 10.2v5.6M13.8 10.2v5.6" }, commonStroke)]
      ],
      play: [
        ["rect", Object.assign({ x: "3.5", y: "5.5", width: "17", height: "13", rx: "3" }, commonStroke)],
        ["path", { d: "m10 9 5 3-5 3Z", fill: "currentColor" }]
      ],
      heart: [
        ["path", Object.assign({ d: "M20.8 8.8c0 5.5-8.8 10.4-8.8 10.4S3.2 14.3 3.2 8.8A4.8 4.8 0 0 1 12 5.5a4.8 4.8 0 0 1 8.8 3.3Z" }, commonStroke)]
      ],
      message: [
        ["path", Object.assign({ d: "M5 5.5h14A1.5 1.5 0 0 1 20.5 7v7A1.5 1.5 0 0 1 19 15.5h-8l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 14V7A1.5 1.5 0 0 1 5 5.5Z" }, commonStroke)]
      ],
      coin: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "8.5" }, commonStroke)],
        ["path", Object.assign({ d: "M12 7.5v9M9.5 10.5h4a2 2 0 0 1 0 4h-4" }, commonStroke)]
      ],
      star: [
        ["path", Object.assign({ d: "m12 3.8 2.5 5.1 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8Z" }, commonStroke)]
      ],
      share: [
        ["circle", Object.assign({ cx: "6", cy: "12", r: "2" }, commonStroke)],
        ["circle", Object.assign({ cx: "18", cy: "6", r: "2" }, commonStroke)],
        ["circle", Object.assign({ cx: "18", cy: "18", r: "2" }, commonStroke)],
        ["path", Object.assign({ d: "m7.8 11 8.4-4M7.8 13l8.4 4" }, commonStroke)]
      ],
      comment: [
        ["path", Object.assign({ d: "M5 5.5h14A1.5 1.5 0 0 1 20.5 7v7A1.5 1.5 0 0 1 19 15.5h-8l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 14V7A1.5 1.5 0 0 1 5 5.5Z" }, commonStroke)],
        ["circle", { cx: "8", cy: "10.5", r: "1", fill: "currentColor" }],
        ["circle", { cx: "12", cy: "10.5", r: "1", fill: "currentColor" }],
        ["circle", { cx: "16", cy: "10.5", r: "1", fill: "currentColor" }]
      ],
      percent: [
        ["path", Object.assign({ d: "M7 17 17 7" }, commonStroke)],
        ["circle", Object.assign({ cx: "7.5", cy: "7.5", r: "1.5" }, commonStroke)],
        ["circle", Object.assign({ cx: "16.5", cy: "16.5", r: "1.5" }, commonStroke)]
      ],
      grid: [
        ["rect", Object.assign({ x: "4", y: "4", width: "6", height: "6", rx: "1" }, commonStroke)],
        ["rect", Object.assign({ x: "14", y: "4", width: "6", height: "6", rx: "1" }, commonStroke)],
        ["rect", Object.assign({ x: "4", y: "14", width: "6", height: "6", rx: "1" }, commonStroke)],
        ["rect", Object.assign({ x: "14", y: "14", width: "6", height: "6", rx: "1" }, commonStroke)]
      ],
      list: [
        ["path", Object.assign({ d: "M9 6h11M9 12h11M9 18h11" }, commonStroke)],
        ["circle", Object.assign({ cx: "4.5", cy: "6", r: "1" }, commonStroke)],
        ["circle", Object.assign({ cx: "4.5", cy: "12", r: "1" }, commonStroke)],
        ["circle", Object.assign({ cx: "4.5", cy: "18", r: "1" }, commonStroke)]
      ],
      "chevron-down": [
        ["path", Object.assign({ d: "m6.5 9.5 5.5 5 5.5-5" }, commonStroke)]
      ],
      "chevron-right": [
        ["path", Object.assign({ d: "m9.5 6.5 5 5.5-5 5.5" }, commonStroke)]
      ],
      spinner: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "8.2", opacity: ".25" }, commonStroke)],
        ["path", Object.assign({ d: "M12 3.8a8.2 8.2 0 0 1 8.2 8.2" }, commonStroke)]
      ],
      success: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "8.5" }, commonStroke)],
        ["path", Object.assign({ d: "m8.2 12.1 2.5 2.5 5.3-5.4" }, commonStroke)]
      ],
      error: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "8.5" }, commonStroke)],
        ["path", Object.assign({ d: "M12 7.5v5.8M12 16.6h.01" }, commonStroke)]
      ],
      info: [
        ["circle", Object.assign({ cx: "12", cy: "12", r: "8.5" }, commonStroke)],
        ["path", Object.assign({ d: "M12 10.6v6M12 7.4h.01" }, commonStroke)]
      ]
    };
    (shapes[name] || shapes.info).forEach(([tagName, attrs]) => svg.appendChild(svgNode(tagName, attrs)));
    return svg;
  }

  function svgNode(tagName, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tagName);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function confirmAction(options) {
    const settings = Object.assign({ title: "确认操作？", message: "", confirmLabel: "确认" }, options || {});
    return new Promise((resolve) => {
      const dialog = el("dialog", { className: "confirm-dialog", "aria-labelledby": "confirm-title" }, [
        el("div", { className: "confirm-dialog-body" }, [
          el("div", { className: "confirm-dialog-icon" }, [iconNode("trash")]),
          el("div", {}, [
            el("h3", { id: "confirm-title", textContent: settings.title }),
            el("p", { textContent: settings.message })
          ])
        ]),
        el("div", { className: "confirm-dialog-actions" }, [
          el("button", { className: "ghost", type: "button", dataset: { role: "confirm-cancel" }, textContent: "取消" }),
          el("button", { className: "danger confirm-danger", type: "button", dataset: { role: "confirm-submit" }, textContent: settings.confirmLabel })
        ])
      ]);
      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        dialog.close();
        resolve(value);
      }
      dialog.querySelector('[data-role="confirm-cancel"]').addEventListener("click", () => finish(false));
      dialog.querySelector('[data-role="confirm-submit"]').addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(false);
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (!finished) {
          finished = true;
          resolve(false);
        }
      });
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('[data-role="confirm-cancel"]').focus();
    });
  }

  function el(tagName, props, children) {
    const node = document.createElement(tagName);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (key === "className") node.className = value;
      else if (key === "textContent") node.textContent = value;
      else if (key === "dataset") Object.entries(value || {}).forEach(([dataKey, dataValue]) => { node.dataset[dataKey] = dataValue; });
      else if (key === "checked") node.checked = Boolean(value);
      else if (key === "disabled") node.disabled = Boolean(value);
      else if (key === "selected") node.selected = Boolean(value);
      else if (key === "value") node.value = value;
      else if (key === "placeholder") node.placeholder = value;
      else if (key === "style") node.setAttribute("style", value);
      else if (key === "title") node.title = value;
      else if (key === "draggable") node.draggable = Boolean(value);
      else if (key === "type") node.type = value;
      else if (key === "href") node.href = value;
      else if (key === "target") node.target = value;
      else if (key === "src") node.src = value;
      else if (key === "alt") node.alt = value;
      else node.setAttribute(key, value);
    });
    (children || []).filter(Boolean).forEach((child) => node.appendChild(child));
    return node;
  }

  function text(value) {
    return document.createTextNode(value);
  }
})();
