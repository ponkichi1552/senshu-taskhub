const extractButton = document.getElementById("extract");
const copyButton = document.getElementById("copy");
const sendButton = document.getElementById("send");
const clearButton = document.getElementById("clear");
const syncNowButton = document.getElementById("syncNow");
const reloadStatusButton = document.getElementById("reloadStatus");
const classroomSyncButton = document.getElementById("classroomSync");
const classroomDueSyncButton = document.getElementById("classroomDueSync");
const incampusDebugButton = document.getElementById("incampusDebug");
const classroomDebugButton = document.getElementById("classroomDebug");
const checkSetupButton = document.getElementById("checkSetup");
const webAppUrlInput = document.getElementById("webAppUrl");
const apiTokenInput = document.getElementById("apiToken");
const toggleApiTokenButton = document.getElementById("toggleApiToken");
const autoSyncEnabledInput = document.getElementById("autoSyncEnabled");
const classroomAutoSyncEnabledInput = document.getElementById("classroomAutoSyncEnabled");
const syncLimitSelect = document.getElementById("syncLimit");
const previewOnlyInput = document.getElementById("previewOnly");
const statusEl = document.getElementById("status");
const syncSummaryEl = document.getElementById("syncSummary");
const outputEl = document.getElementById("output");

const INCAMPUS_HOST = "ic.ss.senshu-u.ac.jp";
const CLASSROOM_HOST = "classroom.google.com";
const ALLOWED_HUB_WEB_APP_HOSTS = new Set([
  "script.google.com",
  "script.googleusercontent.com"
]);
const ALLOWED_SYNC_LIMITS = new Set([10, 25, 50]);
const DEFAULT_SYNC_LIMIT = 25;
const HUB_API_TOKEN_MIN_LENGTH = 48;
const CLASSROOM_AUTO_SYNC_STORAGE_KEYS = [
  "lastClassroomCompletionAutoSyncAt",
  "lastClassroomDueTimeAutoSyncAt",
  "lastClassroomHomeAutoSyncAt"
];

let latestJson = "";
let latestAssignment = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function clearSyncSummary() {
  syncSummaryEl.className = "sync-summary";
  syncSummaryEl.innerHTML = "";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHubWebAppUrl(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  let url;

  try {
    url = new URL(text);
  } catch (_) {
    throw new Error("GAS WebアプリURLの形式が正しくありません。");
  }

  if (url.protocol !== "https:" || !ALLOWED_HUB_WEB_APP_HOSTS.has(url.hostname)) {
    throw new Error("GAS WebアプリURLは script.google.com のWebアプリURLを指定してください。");
  }

  url.hash = "";
  return url.href;
}

function normalizeHubApiToken(value) {
  const token = String(value || "").trim();

  if (!token) {
    return "";
  }

  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length < HUB_API_TOKEN_MIN_LENGTH) {
    throw new Error("APIトークンの形式が正しくありません。Hubのセキュリティ設定からコピーしてください。");
  }

  return token;
}

function normalizeSyncLimit(value) {
  const number = Number(value);

  return ALLOWED_SYNC_LIMITS.has(number) ? number : DEFAULT_SYNC_LIMIT;
}

function isInCampusTab(tab) {
  if (!tab?.url) {
    return false;
  }

  try {
    return new URL(tab.url).hostname === INCAMPUS_HOST;
  } catch (_) {
    return false;
  }
}

function isClassroomTab(tab) {
  if (!tab?.url) {
    return false;
  }

  try {
    return new URL(tab.url).hostname === CLASSROOM_HOST;
  } catch (_) {
    return false;
  }
}

function isMissingContentScriptError(error) {
  const message = String(error?.message || error || "");

  return message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id) {
    throw new Error("操作対象のタブを取得できませんでした。");
  }

  return tab;
}

async function restoreSettings() {
  const { webAppUrl, apiToken, autoSyncEnabled, classroomAutoSyncEnabled, syncLimit, previewOnly } = await chrome.storage.local.get([
    "webAppUrl",
    "apiToken",
    "autoSyncEnabled",
    "classroomAutoSyncEnabled",
    "syncLimit",
    "previewOnly"
  ]);

  webAppUrlInput.value = webAppUrl || "";
  apiTokenInput.value = apiToken || "";
  autoSyncEnabledInput.checked = autoSyncEnabled !== false;
  classroomAutoSyncEnabledInput.checked = classroomAutoSyncEnabled !== false;
  syncLimitSelect.value = String(normalizeSyncLimit(syncLimit));
  previewOnlyInput.checked = Boolean(previewOnly);
}

async function saveWebAppUrl(options = {}) {
  const shouldValidate = Boolean(options.validate);
  const { webAppUrl: previousWebAppUrl } = await chrome.storage.local.get("webAppUrl");
  const webAppUrl = shouldValidate
    ? normalizeHubWebAppUrl(webAppUrlInput.value)
    : webAppUrlInput.value.trim();
  const updates = { webAppUrl };

  if (String(previousWebAppUrl || "") !== webAppUrl) {
    updates.lastInCampusAutoSyncAt = 0;
    CLASSROOM_AUTO_SYNC_STORAGE_KEYS.forEach((key) => {
      updates[key] = 0;
    });
  }

  await chrome.storage.local.set(updates);

  if (shouldValidate) {
    webAppUrlInput.value = webAppUrl;
  }

  return webAppUrl;
}

async function saveApiToken(options = {}) {
  const shouldValidate = Boolean(options.validate);
  const { apiToken: previousApiToken } = await chrome.storage.local.get("apiToken");
  const apiToken = shouldValidate
    ? normalizeHubApiToken(apiTokenInput.value)
    : apiTokenInput.value.trim();
  const updates = { apiToken };

  if (String(previousApiToken || "") !== apiToken) {
    updates.lastInCampusAutoSyncAt = 0;
    CLASSROOM_AUTO_SYNC_STORAGE_KEYS.forEach((key) => {
      updates[key] = 0;
    });
  }

  await chrome.storage.local.set(updates);

  if (shouldValidate) {
    apiTokenInput.value = apiToken;
  }

  return apiToken;
}

async function saveHubConnectionSettings(options = {}) {
  const webAppUrl = await saveWebAppUrl(options);
  const apiToken = await saveApiToken(options);

  return {
    webAppUrl,
    apiToken
  };
}

async function saveAutoSyncEnabled() {
  await chrome.storage.local.set({
    autoSyncEnabled: autoSyncEnabledInput.checked,
    lastInCampusAutoSyncAt: 0
  });

  setStatus(autoSyncEnabledInput.checked
    ? "inCampus自動同期をONにしました。"
    : "inCampus自動同期をOFFにしました。手動同期は使えます。"
  );
}

async function saveClassroomAutoSyncEnabled() {
  const updates = {
    classroomAutoSyncEnabled: classroomAutoSyncEnabledInput.checked
  };

  CLASSROOM_AUTO_SYNC_STORAGE_KEYS.forEach((key) => {
    updates[key] = 0;
  });

  await chrome.storage.local.set(updates);

  setStatus(classroomAutoSyncEnabledInput.checked
    ? "Classroom自動同期をONにしました。"
    : "Classroom自動同期をOFFにしました。手動同期は使えます。"
  );
}

async function saveSyncLimit() {
  const syncLimit = normalizeSyncLimit(syncLimitSelect.value);

  syncLimitSelect.value = String(syncLimit);
  await chrome.storage.local.set({
    syncLimit,
    lastInCampusAutoSyncAt: 0
  });
  setStatus(`同期対象件数を${syncLimit}件にしました。`);
}

async function savePreviewOnly() {
  await chrome.storage.local.set({
    previewOnly: previewOnlyInput.checked,
    lastInCampusAutoSyncAt: 0,
    ...Object.fromEntries(CLASSROOM_AUTO_SYNC_STORAGE_KEYS.map((key) => [key, 0]))
  });
  updateActionButtons();

  setStatus(previewOnlyInput.checked
    ? "プレビューのみをONにしました。Hubへは送信しません。"
    : "プレビューのみをOFFにしました。"
  );
}

function formatSyncDateTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getSyncStatusBadge(status) {
  if (status?.skipped) {
    return { label: "スキップ", className: "skipped" };
  }

  if (status?.dryRun) {
    return { label: "プレビュー", className: "skipped" };
  }

  if (status?.ok) {
    return { label: "成功", className: "" };
  }

  return { label: "要確認", className: "error" };
}

function buildSyncSummaryHtml(status) {
  const badge = getSyncStatusBadge(status);
  const errorCount = Array.isArray(status?.errors) ? status.errors.length : 0;
  const stats = status?.mode === "classroomCompletion"
    ? [
      ["検出", status?.foundCount || 0],
      [status?.dryRun ? "確認" : "完了", status?.dryRun ? status?.previewCount || 0 : status?.matchedCount || 0],
      ["未一致", status?.unmatchedCount || 0],
      ["失敗", errorCount]
    ]
    : status?.mode === "classroomHome"
      ? [
        ["検出", status?.foundCount || 0],
        ["期限", status?.dueTimeCount || 0],
        ["更新", status?.matchedCount || 0],
        ["未一致", status?.unmatchedCount || 0]
      ]
    : status?.mode === "classroomDueTime"
      ? [
        ["検出", status?.foundCount || 0],
        ["時刻", status?.dueTimeCount || 0],
        [status?.dryRun ? "確認" : "更新", status?.dryRun ? status?.previewCount || 0 : status?.matchedCount || 0],
        ["未一致", status?.unmatchedCount || 0]
      ]
    : [
      ["検出", status?.foundCount || 0],
      [status?.dryRun ? "確認" : "新規", status?.dryRun ? status?.previewCount || 0 : status?.newCount || 0],
      ["更新", status?.updatedCount || 0],
      ["失敗", errorCount]
    ];

  return `
    <div class="summary-head">
      <div class="summary-title">同期結果</div>
      <div class="summary-badge ${badge.className}">${badge.label}</div>
    </div>
    <div class="summary-grid">
      ${stats.map(([label, value]) => `
        <div class="summary-item">
          <div class="summary-value">${value}</div>
          <div class="summary-label">${label}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function buildSyncDetailText(status) {
  if (!status) {
    return "まだ同期結果はありません。";
  }

  const lines = [];
  const startedAt = formatSyncDateTime(status.startedAt);
  const finishedAt = formatSyncDateTime(status.finishedAt || status.savedAt);

  if (status.skipped) {
    lines.push(status.reason || "同期をスキップしました。");
  } else if (status.ok) {
    lines.push(status.dryRun
      ? "プレビューが完了しました。Hubへは送信していません。"
      : "同期は正常に完了しました。"
    );
  } else {
    lines.push(status.error || "同期結果に確認が必要です。");
  }

  if (status.limit) {
    lines.push(`同期対象上限: ${status.limit}件`);
  }

  if (status.expandedSectionCount) {
    lines.push(`展開した見出し: ${status.expandedSectionCount}件`);
  }

  if (status.mode === "classroomCompletion") {
    lines.push(`Classroom完了候補: ${status.completedCount || 0}件`);
    lines.push(`反映: ${status.matchedCount || 0}件 / 新規: ${status.createdCount || 0}件 / 未一致: ${status.unmatchedCount || 0}件 / 確認: ${status.previewCount || 0}件 / 送信: ${status.sentCount || 0}件`);
  } else if (status.mode === "classroomHome") {
    lines.push(`Classroomホーム自動同期: 検出 ${status.foundCount || 0}件`);
    lines.push(`期限時刻あり: ${status.dueTimeCount || 0}件 / 完了候補: ${status.completedCount || 0}件`);
    lines.push(`反映: ${status.matchedCount || 0}件 / 新規: ${status.createdCount || 0}件 / 未一致: ${status.unmatchedCount || 0}件 / 送信: ${status.sentCount || 0}件`);
  } else if (status.mode === "classroomDueTime") {
    lines.push(`Classroom期限候補: ${status.foundCount || 0}件 / 時刻あり: ${status.dueTimeCount || 0}件`);
    lines.push(`反映: ${status.matchedCount || 0}件 / 新規: ${status.createdCount || 0}件 / 未一致: ${status.unmatchedCount || 0}件 / 確認: ${status.previewCount || 0}件 / 送信: ${status.sentCount || 0}件`);
  } else {
    lines.push(`課題: ${status.assignmentCount || 0}件 / お知らせ: ${status.announcementCount || 0}件 / 提出: ${status.submissionRecordCount || 0}件`);
    lines.push(`新規: ${status.newCount || 0}件 / 更新: ${status.updatedCount || 0}件 / 確認: ${status.previewCount || 0}件 / 送信: ${status.sentCount || 0}件`);
  }

  if (startedAt) {
    lines.push(`開始: ${startedAt}`);
  }

  if (finishedAt) {
    lines.push(`終了: ${finishedAt}`);
  }

  if (Array.isArray(status.errors) && status.errors.length > 0) {
    lines.push("");
    lines.push("エラー:");
    status.errors.slice(0, 8).forEach((error, index) => {
      lines.push(`${index + 1}. ${error}`);
    });

    if (status.errors.length > 8) {
      lines.push(`...ほか${status.errors.length - 8}件`);
    }
  }

  if (Array.isArray(status.items) && status.items.length > 0) {
    const actionLabels = {
      created: "新規",
      updated: "更新",
      preview: "確認",
      completed: "完了",
      dueTime: "期限",
      unmatched: "未一致",
      failed: "失敗"
    };
    const formatItemLine = (item, index) => {
      const actionLabel = actionLabels[item.action] || item.action || "不明";
      const typeLabel = item.type === "submissionRecord"
        ? "提出"
        : item.type === "classroomCompletion"
          ? "Classroom"
          : item.type === "classroomDueTime"
            ? "期限"
            : item.type === "announcement" ? "お知らせ" : "課題";
      const courseName = item.courseName ? `${item.courseName} / ` : "";
      const title = item.title || item.pageUrl || "タイトル未取得";
      const suffix = item.dueText || item.dueTime ? ` (${item.dueText || item.dueTime})` : "";
      const reason = item.reason ? ` / ${item.reason}` : "";

      return `${index + 1}. [${actionLabel}/${typeLabel}] ${courseName}${title}${suffix}${reason}`;
    };
    const unmatchedItems = status.items.filter((item) => item.action === "unmatched");

    if (unmatchedItems.length > 0) {
      lines.push("");
      lines.push(`未一致 (${unmatchedItems.length}件):`);
      unmatchedItems.forEach((item, index) => {
        lines.push(formatItemLine(item, index));
      });
    }

    lines.push("");
    lines.push(`内訳 (${status.items.length}件):`);
    status.items.forEach((item, index) => {
      lines.push(formatItemLine(item, index));
    });
  }

  return lines.join("\n");
}

function renderSyncStatus(status) {
  syncSummaryEl.innerHTML = buildSyncSummaryHtml(status || {});
  syncSummaryEl.className = "sync-summary visible";
  outputEl.textContent = buildSyncDetailText(status);
}

function renderClassroomDebugPayload(payload) {
  clearSyncSummary();
  latestAssignment = null;
  latestJson = JSON.stringify(payload || {}, null, 2);
  outputEl.textContent = latestJson;
  updateActionButtons();
}

function renderInCampusDebugPayload(payload) {
  clearSyncSummary();
  latestAssignment = null;
  latestJson = JSON.stringify(payload || {}, null, 2);
  outputEl.textContent = latestJson;
  updateActionButtons();
}

async function showLastSyncStatus() {
  const { lastInCampusSyncStatus } = await chrome.storage.local.get("lastInCampusSyncStatus");

  if (!lastInCampusSyncStatus) {
    clearSyncSummary();
    outputEl.textContent = "まだ同期結果はありません。";
    return;
  }

  renderSyncStatus(lastInCampusSyncStatus);
}

function renderSetupCheck(items) {
  const lines = items.map((item) => {
    const mark = item.ok ? "OK" : "要確認";
    return `[${mark}] ${item.label}\n${item.detail}`;
  });

  clearSyncSummary();
  outputEl.textContent = lines.join("\n\n");
}

async function runSetupCheck() {
  setStatus("設定を確認中...");
  const items = [];
  const rawUrl = webAppUrlInput.value.trim();
  const rawApiToken = apiTokenInput.value.trim();

  try {
    const normalizedUrl = normalizeHubWebAppUrl(rawUrl);
    items.push({
      ok: Boolean(normalizedUrl),
      label: "GAS WebアプリURL",
      detail: normalizedUrl || "未設定です。"
    });

    if (normalizedUrl) {
      const diagnosis = await chrome.runtime.sendMessage({
        type: "DIAGNOSE_HUB_WEB_APP_URL",
        webAppUrl: normalizedUrl
      });
      items.push({
        ok: Boolean(diagnosis?.ok),
        label: "GAS URL疎通",
        detail: diagnosis?.message || diagnosis?.error || "確認できませんでした。"
      });
    }
  } catch (error) {
    items.push({
      ok: false,
      label: "GAS WebアプリURL",
      detail: normalizeText(error?.message || error)
    });
  }

  try {
    const apiToken = normalizeHubApiToken(rawApiToken);
    items.push({
      ok: Boolean(apiToken),
      label: "APIトークン",
      detail: apiToken
        ? "設定されています。POST時にJSON本文へ同梱します。"
        : "未設定です。Hubのセキュリティ設定からコピーしてください。"
    });
  } catch (error) {
    items.push({
      ok: false,
      label: "APIトークン",
      detail: normalizeText(error?.message || error)
    });
  }

  try {
    const tab = await getActiveTab();
    const inCampus = isInCampusTab(tab);
    const classroom = isClassroomTab(tab);
    items.push({
      ok: inCampus || classroom,
      label: "現在のタブ",
      detail: inCampus
        ? "inCampusページです。"
        : classroom
          ? "Google Classroomページです。"
          : "inCampusまたはGoogle Classroomページを開いてください。"
    });

    if (inCampus || classroom) {
      const ping = await chrome.tabs.sendMessage(tab.id, {
        type: "PING_INCAMPUS_CONTENT"
      });
      items.push({
        ok: Boolean(ping?.ok),
        label: "content.js",
        detail: ping?.ok
          ? [
            "注入済みです。",
            ping.isHomePage ? "inCampusホーム画面です。" : "",
            ping.isClassroomHomePage ? "Classroomホーム画面です。" : "",
            ping.isClassroomTurnedInPage ? "Classroom完了ページです。" : "",
            ping.isClassroomNotTurnedInPage ? "Classroom未提出ページです。" : "",
            ping.isClassroomPage && !ping.isClassroomHomePage && !ping.isClassroomTurnedInPage && !ping.isClassroomNotTurnedInPage ? "Classroom同期対象ページ以外です。" : ""
          ].filter(Boolean).join(" ")
          : "応答がありません。ページ再読み込みを試してください。"
      });
    }
  } catch (error) {
    items.push({
      ok: false,
      label: "content.js",
      detail: isMissingContentScriptError(error)
        ? "未注入の可能性があります。対象ページを再読み込みしてください。"
        : normalizeText(error?.message || error)
    });
  }

  items.push({
    ok: true,
    label: "自動同期",
    detail: autoSyncEnabledInput.checked ? "ONです。" : "OFFです。手動同期は使えます。"
  });
  items.push({
    ok: true,
    label: "同期対象件数",
    detail: `${normalizeSyncLimit(syncLimitSelect.value)}件まで取得します。`
  });
  items.push({
    ok: true,
    label: "プレビューのみ",
    detail: previewOnlyInput.checked ? "ONです。自動同期・手動同期ともHubへ送信しません。" : "OFFです。"
  });

  renderSetupCheck(items);
  setStatus(items.every((item) => item.ok) ? "設定チェック完了。" : "確認が必要な項目があります。", !items.every((item) => item.ok));
}

function canSend() {
  return Boolean(!previewOnlyInput.checked && latestAssignment && webAppUrlInput.value.trim() && apiTokenInput.value.trim());
}

function updateActionButtons() {
  copyButton.disabled = !latestJson;
  sendButton.disabled = !canSend();
}

extractButton.addEventListener("click", async () => {
  setStatus("抽出中...");
  clearSyncSummary();
  outputEl.textContent = "";
  latestJson = "";
  latestAssignment = null;
  updateActionButtons();

  try {
    const tab = await getActiveTab();

    if (!isInCampusTab(tab)) {
      setStatus("inCampusのページを開いてから実行してください。", true);
      outputEl.textContent = JSON.stringify({ ok: false, pageUrl: tab.url || "" }, null, 2);
      return;
    }

    const payload = await chrome.tabs.sendMessage(tab.id, {
      type: "EXTRACT_INCAMPUS_ASSIGNMENT_FROM_PAGE"
    });

    if (!payload?.ok) {
      setStatus(payload?.error || "抽出に失敗しました。", true);
      outputEl.textContent = JSON.stringify(payload || {}, null, 2);
      return;
    }

    latestAssignment = payload.assignment;
    latestJson = JSON.stringify(latestAssignment, null, 2);
    outputEl.textContent = latestJson;
    updateActionButtons();
    setStatus("抽出できました。");
  } catch (error) {
    if (isMissingContentScriptError(error)) {
      setStatus("inCampusページを再読み込みしてから、もう一度押してください。", true);
      outputEl.textContent = [
        "拡張機能を読み込んだ後に開いていたページには、抽出用スクリプトがまだ入っていない可能性があります。",
        "",
        "1. このinCampusページを再読み込み",
        "2. もう一度「inCampusこのページから抽出」を押す"
      ].join("\n");
      return;
    }

    setStatus("抽出中にエラーが発生しました。", true);
    outputEl.textContent = normalizeText(error?.message || error);
  }
});

copyButton.addEventListener("click", async () => {
  if (!latestJson) return;

  try {
    await navigator.clipboard.writeText(latestJson);
    setStatus("コピーしました。");
  } catch (error) {
    setStatus("コピーに失敗しました。", true);
  }
});

sendButton.addEventListener("click", async () => {
  if (!latestAssignment) return;
  if (previewOnlyInput.checked) {
    setStatus("プレビューのみがONのため、Hubへは送信しません。");
    return;
  }

  setStatus("送信中...");

  try {
    const { webAppUrl, apiToken } = await saveHubConnectionSettings({ validate: true });

    if (!webAppUrl) {
      throw new Error("GAS WebアプリURLを入力してください。");
    }

    if (!apiToken) {
      throw new Error("APIトークンを入力してください。");
    }

    const response = await chrome.runtime.sendMessage({
      type: "POST_INCAMPUS_ASSIGNMENT",
      assignment: latestAssignment
    });

    if (!response?.ok) {
      throw new Error(response?.error || "送信に失敗しました。");
    }

    if (response.result?.dryRun) {
      setStatus("プレビューのみがONのため、Hubへは送信しません。");
      return;
    }

    setStatus(response.result?.updated ? "Hubへ更新しました。" : "Hubへ送信しました。");
  } catch (error) {
    setStatus(normalizeText(error?.message || error), true);
  }
});

clearButton.addEventListener("click", () => {
  latestJson = "";
  latestAssignment = null;
  clearSyncSummary();
  outputEl.textContent = "まだ抽出していません。";
  updateActionButtons();
  setStatus("");
});

syncNowButton.addEventListener("click", async () => {
  const dryRun = previewOnlyInput.checked;

  setStatus(dryRun ? "更新一覧をプレビュー中..." : "更新一覧から同期中...");
  clearSyncSummary();
  outputEl.textContent = "";

  try {
    const settings = dryRun
      ? {
        webAppUrl: webAppUrlInput.value.trim(),
        apiToken: apiTokenInput.value.trim()
      }
      : await saveHubConnectionSettings({ validate: true });

    if (!dryRun && !settings.webAppUrl) {
      setStatus("GAS WebアプリURLを入力してください。", true);
      return;
    }

    if (!dryRun && !settings.apiToken) {
      setStatus("APIトークンを入力してください。", true);
      return;
    }

    const tab = await getActiveTab();

    if (!isInCampusTab(tab)) {
      setStatus("inCampusのページを開いてから実行してください。", true);
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_INCAMPUS_SYNC",
      force: true,
      limit: normalizeSyncLimit(syncLimitSelect.value),
      dryRun
    });

    renderSyncStatus(result || {});

    if (!result?.ok && result?.errors?.length) {
      setStatus("同期は完了しましたが、エラーがあります。", true);
      return;
    }

    if (!result?.ok && result?.error) {
      setStatus(result.error, true);
      return;
    }

    setStatus(dryRun || result?.dryRun || result?.previewOnly
      ? `プレビュー完了: ${result?.previewCount || 0}件確認`
      : `同期完了: ${result?.sentCount || 0}件送信`
    );
  } catch (error) {
    if (isMissingContentScriptError(error)) {
      setStatus("inCampusページを再読み込みしてから、もう一度押してください。", true);
      outputEl.textContent = [
        "拡張機能を読み込んだ後に開いていたページには、同期用スクリプトがまだ入っていない可能性があります。",
        "",
        "1. このinCampusページを再読み込み",
        "2. もう一度「更新一覧から同期」を押す",
        "",
        "それでも直らない場合は、chrome://extensions/ で拡張機能を再読み込みしてください。"
      ].join("\n");
      return;
    }

    setStatus(normalizeText(error?.message || error), true);
  }
});

classroomSyncButton.addEventListener("click", async () => {
  const dryRun = previewOnlyInput.checked;

  setStatus(dryRun ? "Classroom完了情報をプレビュー中..." : "Classroom完了情報を同期中...");
  clearSyncSummary();
  outputEl.textContent = "";

  try {
    const settings = dryRun
      ? {
        webAppUrl: webAppUrlInput.value.trim(),
        apiToken: apiTokenInput.value.trim()
      }
      : await saveHubConnectionSettings({ validate: true });

    if (!dryRun && !settings.webAppUrl) {
      setStatus("GAS WebアプリURLを入力してください。", true);
      return;
    }

    if (!dryRun && !settings.apiToken) {
      setStatus("APIトークンを入力してください。", true);
      return;
    }

    const tab = await getActiveTab();

    if (!isClassroomTab(tab)) {
      setStatus("Google Classroomの完了ページを開いてから実行してください。", true);
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_CLASSROOM_COMPLETION_SYNC",
      dryRun
    });

    renderSyncStatus(result || {});

    if (!result?.ok && result?.errors?.length) {
      setStatus("Classroom完了同期は完了しましたが、エラーがあります。", true);
      return;
    }

    if (!result?.ok && result?.error) {
      setStatus(result.error, true);
      return;
    }

    setStatus(dryRun || result?.dryRun || result?.previewOnly
      ? `プレビュー完了: ${result?.previewCount || 0}件確認`
      : `Classroom完了同期: ${result?.matchedCount || 0}件完了`
    );
  } catch (error) {
    if (isMissingContentScriptError(error)) {
      setStatus("Classroomページを再読み込みしてから、もう一度押してください。", true);
      outputEl.textContent = [
        "拡張機能を読み込んだ後に開いていたページには、同期用スクリプトがまだ入っていない可能性があります。",
        "",
        "1. Google Classroomの完了ページを再読み込み",
        "2. もう一度「Classroom完了同期」を押す",
        "",
        "それでも直らない場合は、chrome://extensions/ で拡張機能を再読み込みしてください。"
      ].join("\n");
      return;
    }

    setStatus(normalizeText(error?.message || error), true);
  }
});

classroomDueSyncButton.addEventListener("click", async () => {
  const dryRun = previewOnlyInput.checked;

  setStatus(dryRun ? "Classroom期限情報をプレビュー中..." : "Classroom期限情報を同期中...");
  clearSyncSummary();
  outputEl.textContent = "";

  try {
    const settings = dryRun
      ? {
        webAppUrl: webAppUrlInput.value.trim(),
        apiToken: apiTokenInput.value.trim()
      }
      : await saveHubConnectionSettings({ validate: true });

    if (!dryRun && !settings.webAppUrl) {
      setStatus("GAS WebアプリURLを入力してください。", true);
      return;
    }

    if (!dryRun && !settings.apiToken) {
      setStatus("APIトークンを入力してください。", true);
      return;
    }

    const tab = await getActiveTab();

    if (!isClassroomTab(tab)) {
      setStatus("Google Classroomの未提出ページを開いてから実行してください。", true);
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_CLASSROOM_DUE_TIME_SYNC",
      dryRun
    });

    renderSyncStatus(result || {});

    if (!result?.ok && result?.errors?.length) {
      setStatus("Classroom期限同期は完了しましたが、エラーがあります。", true);
      return;
    }

    if (!result?.ok && result?.error) {
      setStatus(result.error, true);
      return;
    }

    setStatus(dryRun || result?.dryRun || result?.previewOnly
      ? `プレビュー完了: ${result?.previewCount || 0}件確認`
      : `Classroom期限同期: ${result?.matchedCount || 0}件更新`
    );
  } catch (error) {
    if (isMissingContentScriptError(error)) {
      setStatus("Classroomページを再読み込みしてから、もう一度押してください。", true);
      outputEl.textContent = [
        "拡張機能を読み込んだ後に開いていたページには、同期用スクリプトがまだ入っていない可能性があります。",
        "",
        "1. Google Classroomの未提出ページを再読み込み",
        "2. もう一度「Classroom期限同期」を押す",
        "",
        "それでも直らない場合は、chrome://extensions/ で拡張機能を再読み込みしてください。"
      ].join("\n");
      return;
    }

    setStatus(normalizeText(error?.message || error), true);
  }
});

incampusDebugButton.addEventListener("click", async () => {
  setStatus("inCampus送信予定データを抽出中...");
  clearSyncSummary();
  outputEl.textContent = "";
  latestJson = "";
  latestAssignment = null;
  updateActionButtons();

  try {
    const tab = await getActiveTab();

    if (!isInCampusTab(tab)) {
      setStatus("inCampusのページを開いてから実行してください。", true);
      outputEl.textContent = JSON.stringify({
        ok: false,
        pageUrl: tab.url || "",
        error: "inCampusのページではありません。"
      }, null, 2);
      return;
    }

    const payload = await chrome.tabs.sendMessage(tab.id, {
      type: "DEBUG_EXTRACT_INCAMPUS_PAYLOAD",
      limit: normalizeSyncLimit(syncLimitSelect.value)
    });

    renderInCampusDebugPayload(payload || {});

    const hasErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;

    setStatus(
      `送信予定を表示しました。課題${payload?.assignmentCount || 0}件 / お知らせ${payload?.announcementCount || 0}件 / 提出${payload?.submissionRecordCount || 0}件`,
      !payload?.ok || hasErrors
    );
  } catch (error) {
    if (isMissingContentScriptError(error)) {
      setStatus("inCampusページを再読み込みしてから、もう一度押してください。", true);
      outputEl.textContent = [
        "拡張機能を読み込んだ後に開いていたページには、抽出用スクリプトがまだ入っていない可能性があります。",
        "",
        "1. inCampusページを再読み込み",
        "2. もう一度「inCampus送信予定を見る」を押す"
      ].join("\n");
      return;
    }

    setStatus("inCampus送信予定データの抽出中にエラーが発生しました。", true);
    outputEl.textContent = normalizeText(error?.message || error);
  }
});

classroomDebugButton.addEventListener("click", async () => {
  setStatus("Classroom送信予定データを抽出中...");
  clearSyncSummary();
  outputEl.textContent = "";
  latestJson = "";
  latestAssignment = null;
  updateActionButtons();

  try {
    const tab = await getActiveTab();

    if (!isClassroomTab(tab)) {
      setStatus("Google Classroomのページを開いてから実行してください。", true);
      outputEl.textContent = JSON.stringify({
        ok: false,
        pageUrl: tab.url || "",
        error: "Google Classroomのページではありません。"
      }, null, 2);
      return;
    }

    const payload = await chrome.tabs.sendMessage(tab.id, {
      type: "DEBUG_EXTRACT_CLASSROOM_PAYLOAD"
    });

    renderClassroomDebugPayload(payload || {});

    const payloads = Array.isArray(payload?.payloads) ? payload.payloads : [];
    const completionCount = payloads
      .filter((item) => item.mode === "completion")
      .reduce((sum, item) => sum + Number(item.foundCount || 0), 0);
    const dueTimeCount = payloads
      .filter((item) => item.mode === "dueTime")
      .reduce((sum, item) => sum + Number(item.foundCount || 0), 0);
    const hasErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;

    setStatus(
      `送信予定を表示しました。完了${completionCount}件 / 期限${dueTimeCount}件`,
      !payload?.ok || hasErrors
    );
  } catch (error) {
    if (isMissingContentScriptError(error)) {
      setStatus("Classroomページを再読み込みしてから、もう一度押してください。", true);
      outputEl.textContent = [
        "拡張機能を読み込んだ後に開いていたページには、抽出用スクリプトがまだ入っていない可能性があります。",
        "",
        "1. Google Classroomページを再読み込み",
        "2. もう一度「Classroom送信予定を見る」を押す"
      ].join("\n");
      return;
    }

    setStatus("Classroom送信予定データの抽出中にエラーが発生しました。", true);
    outputEl.textContent = normalizeText(error?.message || error);
  }
});

reloadStatusButton.addEventListener("click", async () => {
  await showLastSyncStatus();
  setStatus("直近の同期結果を表示しました。");
});

checkSetupButton.addEventListener("click", runSetupCheck);

webAppUrlInput.addEventListener("change", async () => {
  await saveWebAppUrl();
  updateActionButtons();
});

webAppUrlInput.addEventListener("input", updateActionButtons);

apiTokenInput.addEventListener("change", async () => {
  await saveApiToken();
  updateActionButtons();
});

apiTokenInput.addEventListener("input", updateActionButtons);

toggleApiTokenButton.addEventListener("click", () => {
  const visible = apiTokenInput.type === "text";
  apiTokenInput.type = visible ? "password" : "text";
  toggleApiTokenButton.textContent = visible ? "表示" : "隠す";
});

autoSyncEnabledInput.addEventListener("change", saveAutoSyncEnabled);
classroomAutoSyncEnabledInput.addEventListener("change", saveClassroomAutoSyncEnabled);
syncLimitSelect.addEventListener("change", saveSyncLimit);
previewOnlyInput.addEventListener("change", savePreviewOnly);

restoreSettings()
  .then(updateActionButtons)
  .catch((error) => {
    setStatus(normalizeText(error?.message || error), true);
  });

// Open the notice screen without including the API token in the URL.
document.getElementById("openUniversityNotices").addEventListener("click", async () => {
  try {
    const value = normalizeHubWebAppUrl(webAppUrlInput.value);
    if (!value) { setStatus("GAS WebアプリURLを入力してください。", true); return; }
    const url = new URL(value);
    if (url.hostname !== "script.google.com" || !/\/exec$/.test(url.pathname)) throw new Error("script.google.com の /exec で終わるWebアプリURLを指定してください。");
    url.search = "";
    url.searchParams.set("view", "university");
    await chrome.tabs.create({url: url.href});
  } catch (error) { setStatus(error.message || String(error), true); }
});
