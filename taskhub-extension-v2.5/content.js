const INCAMPUS_HOST = "ic.ss.senshu-u.ac.jp";
const INCAMPUS_ORIGIN = `https://${INCAMPUS_HOST}`;
const UPDATEINFO_PATH = "/updateinfo";
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const INCAMPUS_AUTO_SYNC_START_DELAY_MS = 0;
// History/lifecycle events handle normal navigation; this is only a fallback
// for inCampus pages that change the URL without notifying the browser.
const HOME_URL_WATCH_INTERVAL_MS = 5000;
const DEFAULT_DETAIL_FETCH_LIMIT = 25;
const DETAIL_FETCH_CONCURRENCY = 4;
const INCAMPUS_FETCH_TIMEOUT_MS = 15000;
const FAILED_SYNC_RETRY_INTERVAL_MS = 60 * 1000;
const ALLOWED_DETAIL_FETCH_LIMITS = new Set([10, 25, 50]);
const AUTO_SYNC_WATCHER_INSTALLED_KEY = "__taskhubAutoSyncWatcherInstalled";
let isSyncing = false;
let pendingHomeAutoSyncTimerId = 0;
let lastObservedUrl = location.href;
function showInCampusSyncDebug(message, isError = false) {
  const id = "incampus-hub-sync-debug";
  let box = document.getElementById(id);

  if (!box) {
    box = document.createElement("div");
    box.id = id;
    box.style.position = "fixed";
    box.style.right = "16px";
    box.style.bottom = "16px";
    box.style.zIndex = "2147483647";
    box.style.maxWidth = "360px";
    box.style.padding = "10px 12px";
    box.style.borderRadius = "10px";
    box.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.22)";
    box.style.fontSize = "13px";
    box.style.fontWeight = "700";
    box.style.lineHeight = "1.45";
    box.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    document.documentElement.appendChild(box);
  }

  box.textContent = `[課題通知Hub] ${message}`;
  box.style.color = "#ffffff";
  box.style.background = isError ? "#c2410c" : "#2563eb";
  box.style.display = "block";

  window.clearTimeout(showInCampusSyncDebug.timerId);
  showInCampusSyncDebug.timerId = window.setTimeout(() => {
    box.style.display = "none";
  }, 7000);
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

function normalizeLabel(text) {
  return normalizeText(text).replace(/[：:]\s*$/, "");
}

function normalizeDetailFetchLimit(value) {
  const number = Number(value);

  return ALLOWED_DETAIL_FETCH_LIMITS.has(number) ? number : DEFAULT_DETAIL_FETCH_LIMIT;
}

function getElementText(element) {
  if (!element) {
    return "";
  }

  // DOMParser documents have no rendered innerText. Exclude the hidden file
  // metadata and form values in the actual inCampus HTML before reading text.
  if (typeof element.cloneNode !== 'function') return normalizeText(element.innerText || element.textContent);
  const copy = element.cloneNode(true);
  copy.querySelectorAll('script, style, input, select, textarea, .contents-hidden, [hidden], [aria-hidden="true"], [style]').forEach(node => {
    if (node.matches('script, style, input, select, textarea, .contents-hidden, [hidden], [aria-hidden="true"]') ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute('style') || '')) node.remove();
  });
  copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  copy.querySelectorAll('p, div, li, tr').forEach(node => node.append('\n'));
  return normalizeText(copy.textContent);
}

function firstText(root, selectors) {
  for (const selector of selectors) {
    const text = getElementText(root.querySelector(selector));

    if (text) {
      return text;
    }
  }

  return "";
}

function getInputValue(root, names) {
  const loweredNames = names.map((name) => name.toLowerCase());
  const input = Array.from(root.querySelectorAll("input"))
    .find((candidate) => {
      const id = String(candidate.id || "").toLowerCase();
      const name = String(candidate.name || "").toLowerCase();

      return loweredNames.includes(id) || loweredNames.includes(name);
    });

  return input?.value || "";
}

function toAbsoluteInCampusUrl(path) {
  const rawPath = String(path || "").trim();

  if (!rawPath) {
    return "";
  }

  try {
    const url = new URL(rawPath, INCAMPUS_ORIGIN);

    if (url.origin !== INCAMPUS_ORIGIN || url.username || url.password) {
      return "";
    }

    url.hash = "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function isInCampusPage() {
  return location.hostname === INCAMPUS_HOST;
}

function isInCampusHomePage() {
  const normalizedPath = location.pathname.replace(/\/+$/, "");

  return isInCampusPage() && normalizedPath === "/portal/home";
}

function parseHtml(html) {
  return new DOMParser().parseFromString(String(html || ""), "text/html");
}

async function fetchInCampusHtml(url) {
  const safeUrl = toAbsoluteInCampusUrl(url);
  if (!safeUrl) throw new Error('取得先がinCampusのURLではありません。');
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), INCAMPUS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(safeUrl, {method: 'GET', credentials: 'include', signal: controller.signal});
    if (!response.ok) throw new Error(`inCampusの取得に失敗しました。status=${response.status}`);
    if (response.url) {
      const finalUrl = new URL(response.url);
      const requestedUrl = new URL(safeUrl);
      if (finalUrl.origin !== INCAMPUS_ORIGIN || finalUrl.pathname !== requestedUrl.pathname ||
        ['idnumber', 'reportId'].some(key => requestedUrl.searchParams.has(key) && finalUrl.searchParams.get(key) !== requestedUrl.searchParams.get(key))) {
        throw new Error('inCampusのログイン状態または課題のアクセス権を確認してください。取得先が別の画面に変更されました。');
      }
    }
    return await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('inCampusの読み取りが15秒でタイムアウトしました。');
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function extractButtonUrl(button) {
  if (!button) {
    return "";
  }

  const candidates = [
    button.value,
    button.getAttribute("data-url"),
    button.getAttribute("data-href"),
    button.getAttribute("href"),
    button.formAction
  ];
  const onclick = button.getAttribute("onclick") || "";
  const onclickMatch = onclick.match(/['"]([^'"]*(?:report|contents|detail)[^'"]*)['"]/i);

  if (onclickMatch?.[1]) {
    candidates.push(onclickMatch[1]);
  }

  for (const candidate of candidates) {
    const url = toAbsoluteInCampusUrl(candidate);

    if (url) {
      return url;
    }
  }

  return "";
}

function buildAssignmentKey(notification) {
  if (notification.kind === "submissionRecord") {
    return buildSubmissionRecordKey(notification);
  }

  if (notification.reportId) {
    return ["inCampus", notification.idnumber, notification.reportId]
      .filter(Boolean)
      .join(":");
  }

  if (notification.updateInfoId) {
    return `inCampus:update:${notification.updateInfoId}`;
  }

  return notification.detailUrl || "";
}

function buildSubmissionRecordKey(notification) {
  const parts = [
    "inCampus",
    "submission",
    notification.idnumber,
    notification.reportId,
    notification.updateInfoId,
    notification.titleFromUpdate
  ].filter(Boolean);

  return parts.length > 2
    ? parts.join(":")
    : `inCampus:submission:${notification.detailUrl || normalizeText(notification.updateText).slice(0, 80) || "unknown"}`;
}

function dedupeNotifications(notifications) {
  const seen = new Set();

  return notifications.filter((notification) => {
    const key = notification.assignmentKey || notification.detailUrl || notification.updateText;

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getUpdateInfoRows(doc) {
  const rows = Array.from(doc.querySelectorAll(".update-info-student"));

  if (rows.length > 0) {
    return rows;
  }

  return Array.from(doc.querySelectorAll("button.updateInfoUrl"))
    .map((button) => button.closest("li, tr, .row, .card, div") || button)
    .filter(Boolean);
}

function parseCourseNameFromUpdateText(text, spans) {
  const bracketMatch = normalizeText(text).match(/[［\[]([^］\]]+)[］\]]/);

  if (bracketMatch?.[1]) {
    return normalizeText(bracketMatch[1]);
  }

  return normalizeText((spans[0] || "").replace(/^[［\[]/, "").replace(/[］\]]$/, ""));
}

function getInCampusUpdateKind(text) {
  const prefix = normalizeText(text).replace(/^[・･·\s]+/, '').slice(0, 2);
  return prefix === '課題' ? 'assignment' : prefix === 'お知' ? 'announcement' : '';
}

function extractTitleFromUpdateText(text) {
  const normalized = normalizeText(text).replace(/^[・･·\s]+/, '');
  // Greedy outer capture preserves parentheses inside the actual title.
  const match = normalized.match(/^(?:課題|お知らせ)\s*[（(](.*)[）)]\s*(?:が|を)/) ||
    normalized.match(/^(?:課題|お知らせ)\s*[「『](.*)[」』]\s*(?:が|を)/);
  return match ? normalizeText(match[1]) : '';
}

function buildUpdateInfoFallbackUrl(updateInfoId, text) {
  const url = new URL(UPDATEINFO_PATH, INCAMPUS_ORIGIN);
  const key = updateInfoId || normalizeText(text).slice(0, 80) || "unknown";

  url.hash = `submission-${encodeURIComponent(key)}`;
  return url.href;
}

function parseReportNotifications(updateInfoHtml) {
  const doc = parseHtml(updateInfoHtml);
  if (!doc.querySelector('#updateInfoForm, .update-info-student, button.updateInfoUrl')) {
    throw new Error('inCampusの更新一覧を確認できませんでした。ログイン切れや画面変更を確認してください。');
  }

  return getUpdateInfoRows(doc)
    .map((row) => {
      const button = row.querySelector?.("button.updateInfoUrl") || row;
      const rowText = getElementText(row);
      const detailUrl = extractButtonUrl(button);

      const spans = Array.from(button?.querySelectorAll?.("span") || [])
        .map((span) => normalizeText(span.textContent))
        .filter(Boolean);
      const courseName = parseCourseNameFromUpdateText(rowText, spans);
      const updateText = normalizeText(spans.length > 1 ? spans.slice(1).join("\n") : rowText
        .replace(/^\s*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*/, '')
        .replace(/^[［\[][^］\]]+[］\]]\s*/, ''));
      const updateKind = getInCampusUpdateKind(updateText);
      if (!updateKind) return null;
      const submissionTitle = updateKind === 'assignment' && /を提出しました/.test(updateText)
        ? extractTitleFromUpdateText(updateText) : '';
      const titleFromUpdate = submissionTitle || extractTitleFromUpdateText(updateText);
      const kind = submissionTitle ? "submissionRecord" : updateKind;

      const detailParameters = detailUrl ? new URL(detailUrl).searchParams : new URLSearchParams();
      const selectionId = getInputValue(row, ['deleteUpdateInfoList']).match(/^\d+-(\d+)$/)?.[1] || '';
      const notification = {
        kind,
        idnumber: getInputValue(row, ["idnumber", "idNumber"]) || detailParameters.get('idnumber') || '',
        reportId: getInputValue(row, ["contentId", "reportId"]) || detailParameters.get('reportId') || '',
        updateInfoId: getInputValue(row, ["updateInfoId"]) || selectionId,
        action: getInputValue(row, ["info_action", "infoAction"]),
        courseName,
        updateText,
        updateAt: firstText(row, [
          ".update-info-url label",
          "time",
          ".date",
          ".update-date",
          ".datetime"
        ]),
        titleFromUpdate,
        detailUrl: detailUrl || buildUpdateInfoFallbackUrl(getInputValue(row, ["updateInfoId"]) || selectionId, updateText),
        extractionError: kind !== 'submissionRecord' && !detailUrl ? '更新通知のリンクを確認できませんでした。' : ''
      };

      return {
        ...notification,
        assignmentKey: buildAssignmentKey(notification)
      };
    })
    .filter(Boolean);
}

function setDetailValue(details, label, value) {
  const normalizedLabel = normalizeLabel(label);
  const normalizedValue = normalizeText(value);

  if (normalizedLabel && normalizedValue && !details[normalizedLabel]) {
    details[normalizedLabel] = normalizedValue;
  }
}

function parseDetailLabels(doc) {
  const details = {};

  doc.querySelectorAll(".contents-detail").forEach((section) => {
    const label = firstText(section, [
      ".contents-header .bold-txt",
      ".contents-header",
      ".bold-txt",
      "th",
      "dt",
      "label"
    ]);
    const value = firstText(section, [
      ".contents-input-area",
      ".contents-body",
      ".contents-value",
      ".input-area",
      "td",
      "dd"
    ]);

    setDetailValue(details, label, value);
  });

  doc.querySelectorAll("tr").forEach((row) => {
    const label = firstText(row, ["th", ".label", ".item-name"]);
    const value = firstText(row, ["td", ".value", ".item-value"]);
    setDetailValue(details, label, value);
  });

  doc.querySelectorAll("dl").forEach((list) => {
    const labels = Array.from(list.querySelectorAll("dt"));

    labels.forEach((labelNode) => {
      const valueNode = labelNode.nextElementSibling?.matches("dd")
        ? labelNode.nextElementSibling
        : null;
      setDetailValue(details, getElementText(labelNode), getElementText(valueNode));
    });
  });

  return details;
}

function findDetailValue(details, labels) {
  const normalizedEntries = Object.entries(details)
    .map(([key, value]) => [normalizeLabel(key), value]);

  for (const label of labels) {
    const exact = normalizedEntries.find(([key]) => key === label);

    if (exact?.[1]) {
      return exact[1];
    }
  }

  for (const label of labels) {
    const partial = normalizedEntries.find(([key]) => key.includes(label) || label.includes(key));

    if (partial?.[1]) {
      return partial[1];
    }
  }

  return "";
}

function splitPeriodText(periodText) {
  return normalizeText(periodText)
    .split(/\s*[～〜~]\s*|\s+(?:－|–|—|-)\s+/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function extractPageHeadings(doc) {
  return Array.from(doc.querySelectorAll("h1, h2, h3, .contents-title, .page-title, .title"))
    .map((node) => normalizeText(node.textContent))
    .filter(Boolean);
}

function extractAssignmentFromDetailHtml(detailHtml, pageUrl, notification) {
  // A course overview is never a report detail, even if it has a heading.
  if (!/^https:\/\/ic\.ss\.senshu-u\.ac\.jp\/lms\/course\/report\//.test(pageUrl)) return null;
  const doc = parseHtml(detailHtml);
  const details = parseDetailLabels(doc);
  const pageHeadings = extractPageHeadings(doc);
  const periodText = findDetailValue(details, ["提出期間", "期間", "受付期間"]);
  const periodParts = splitPeriodText(periodText);
  const title = findDetailValue(details, ["タイトル", "課題名", "課題タイトル", "レポート名"]) ||
    notification.titleFromUpdate ||
    pageHeadings[0] ||
    "";
  const body = findDetailValue(details, ["内容", "課題内容", "説明", "詳細", "本文"]);

  if (!title || !Object.keys(details).some(label => /^(?:タイトル|課題名|課題タイトル|レポート名)$/.test(label)) || (!body && !periodText)) {
    return null;
  }

  return {
    source: "inCampus",
    type: "assignment",
    courseName: notification.courseName || "",
    title,
    body,
    attachment: findDetailValue(details, ["添付ファイル", "添付", "ファイル"]),
    startAt: periodParts[0] || "",
    dueAt: periodParts[1] || "",
    periodText,
    lateSubmission: findDetailValue(details, ["期間外提出", "期限後提出"]),
    assignmentType: findDetailValue(details, ["課題種別", "種別"]),
    pageUrl,
    assignmentKey: notification.assignmentKey || buildAssignmentKey(notification),
    idnumber: notification.idnumber || "",
    reportId: notification.reportId || "",
    updateInfoId: notification.updateInfoId || "",
    updateAction: notification.action || "",
    updateText: notification.updateText || "",
    updateAt: notification.updateAt || "",
    extractedAt: new Date().toISOString(),
    rawLabels: details,
    pageHeadings
  };
}

function buildInCampusAnnouncement(notification) {
  if (!notification.titleFromUpdate) return null;
  return {
    source: 'inCampus', type: 'announcement', courseName: notification.courseName || '',
    title: notification.titleFromUpdate, body: '', pageUrl: notification.detailUrl,
    assignmentKey: notification.assignmentKey, updateText: notification.updateText,
    updateAction: notification.action || '', updateAt: notification.updateAt || '',
    extractedAt: new Date().toISOString()
  };
}

function extractInCampusAssignmentFromCurrentPage() {
  if (!isInCampusPage()) {
    return {
      ok: false,
      error: "inCampusのページではありません。"
    };
  }

  const pageUrl = location.href;
  const url = new URL(pageUrl);
  const heading = firstText(document, ['.course-title-txt']).replace(/^\d+\s+/, '');
  const assignment = extractAssignmentFromDetailHtml(
    document.documentElement.outerHTML,
    pageUrl,
    {
      detailUrl: pageUrl,
      assignmentKey: pageUrl,
      idnumber: url.searchParams.get('idnumber') || '',
      reportId: url.searchParams.get('reportId') || '',
      courseName: heading
    }
  );

  if (!assignment) {
    return {
      ok: false,
      error: "課題情報らしいHTMLが見つかりませんでした。課題詳細ページで実行してください。",
      pageUrl
    };
  }

  return {
    ok: true,
    assignment
  };
}

function buildSubmissionRecordAssignment(notification) {
  const title = notification.titleFromUpdate || "";

  if (!title) {
    return null;
  }

  return {
    source: "inCampus",
    type: "submissionRecord",
    courseName: notification.courseName || "",
    title,
    body: notification.updateText || `課題（${title}）を提出しました`,
    attachment: "",
    startAt: "",
    dueAt: "",
    periodText: notification.updateText || `課題（${title}）を提出しました`,
    lateSubmission: "",
    assignmentType: "",
    pageUrl: notification.detailUrl || buildUpdateInfoFallbackUrl(notification.updateInfoId, notification.updateText),
    assignmentKey: notification.assignmentKey || buildSubmissionRecordKey(notification),
    idnumber: notification.idnumber || "",
    reportId: notification.reportId || "",
    updateInfoId: notification.updateInfoId || "",
    updateAction: notification.action || "",
    updateText: notification.updateText || "",
    updateAt: notification.updateAt || "",
    submittedAt: notification.updateAt || "",
    rawText: notification.updateText || "",
    extractedAt: new Date().toISOString()
  };
}

async function collectInCampusAssignmentsFromHtml(updateInfoHtml, limit) {
  const allNotifications = dedupeNotifications(parseReportNotifications(updateInfoHtml));
  const notifications = allNotifications.slice(0, limit);
  const result = {
    eligibleCount: allNotifications.length,
    skippedByLimitCount: Math.max(0, allNotifications.length - notifications.length),
    foundCount: notifications.length,
    assignmentCount: 0,
    announcementCount: 0,
    submissionRecordCount: 0,
    detailPageCount: 0,
    assignments: [],
    errors: []
  };
  const detailHtmlPromisesByUrl = new Map();
  const extractedRecords = new Array(notifications.length);
  let nextNotificationIndex = 0;

  async function extractNotification(notification) {
    let assignment = null;
    if (notification.extractionError) throw new Error(notification.extractionError);

    if (notification.kind === "submissionRecord") {
      assignment = buildSubmissionRecordAssignment(notification);
    } else if (notification.kind === "announcement") {
      assignment = buildInCampusAnnouncement(notification);
    } else {
      const detailUrl = toAbsoluteInCampusUrl(notification.detailUrl);
      if (!detailUrl) throw new Error("課題詳細URLがinCampusのURLではありません。");
      let detailHtmlPromise = detailHtmlPromisesByUrl.get(detailUrl);
      if (!detailHtmlPromise) {
        detailHtmlPromise = fetchInCampusHtml(detailUrl);
        detailHtmlPromisesByUrl.set(detailUrl, detailHtmlPromise);
      }
      const detailHtml = await detailHtmlPromise;
      assignment = extractAssignmentFromDetailHtml(detailHtml, notification.detailUrl, notification);
    }

    if (!assignment) throw new Error(`${notification.detailUrl}: 課題情報を抽出できませんでした。`);
    return {assignment};
  }

  async function worker() {
    while (true) {
      const index = nextNotificationIndex++;
      if (index >= notifications.length) return;
      try {
        extractedRecords[index] = await extractNotification(notifications[index]);
      } catch (error) {
        extractedRecords[index] = {error: String(error?.message || error)};
      }
    }
  }

  const workerCount = Math.min(DETAIL_FETCH_CONCURRENCY, notifications.length);
  await Promise.all(Array.from({length: workerCount}, () => worker()));
  result.detailPageCount = detailHtmlPromisesByUrl.size;

  extractedRecords.forEach(record => {
    if (record?.error) {
      result.errors.push(record.error);
      return;
    }
    const assignment = record?.assignment;
    if (!assignment) return;
    if (assignment.type === "submissionRecord") result.submissionRecordCount++;
    else if (assignment.type === "announcement") result.announcementCount++;
    else result.assignmentCount++;
    result.assignments.push(assignment);
  });

  return result;
}

async function extractInCampusDebugPayload(options = {}) {
  const limit = Object.prototype.hasOwnProperty.call(options, "limit")
    ? normalizeDetailFetchLimit(options.limit)
    : await getStoredSyncLimit();
  const payload = {
    ok: false,
    source: "inCampus",
    debug: true,
    mode: "updateInfo",
    pageUrl: location.href,
    limit,
    extractedAt: new Date().toISOString(),
    foundCount: 0,
    recordCount: 0,
    assignmentCount: 0,
    announcementCount: 0,
    submissionRecordCount: 0,
    records: [],
    requestBodyPreview: {
      action: "upsertInCampusAssignments",
      assignments: []
    },
    errors: []
  };

  if (!isInCampusPage()) {
    payload.error = "inCampusのページではありません。";
    payload.errors.push(payload.error);
    return payload;
  }

  try {
    const updateInfoHtml = await fetchInCampusHtml(toAbsoluteInCampusUrl(UPDATEINFO_PATH));
    const extracted = await collectInCampusAssignmentsFromHtml(updateInfoHtml, limit);
    payload.foundCount = extracted.foundCount;
    payload.eligibleCount = extracted.eligibleCount;
    payload.skippedByLimitCount = extracted.skippedByLimitCount;
    payload.assignmentCount = extracted.assignmentCount;
    payload.announcementCount = extracted.announcementCount;
    payload.submissionRecordCount = extracted.submissionRecordCount;
    payload.records = extracted.assignments;
    payload.errors.push(...extracted.errors);

    payload.recordCount = payload.records.length;
    payload.requestBodyPreview.assignments = payload.records;
    payload.ok = payload.errors.length === 0;
    return payload;
  } catch (error) {
    payload.error = String(error?.message || error);
    payload.errors.push(payload.error);
    return payload;
  }
}

async function saveSyncStatus(status) {
  return chrome.runtime.sendMessage({
    type: "SAVE_INCAMPUS_SYNC_STATUS",
    status
  });
}

async function getHubConnectionStatus() {
  try {
    return await chrome.runtime.sendMessage({
      type: "GET_HUB_CONNECTION_STATUS"
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error)
    };
  }
}

function getHubConnectionError(status) {
  return status?.error || "GAS WebアプリURLまたはAPIトークンが未設定です。拡張機能のポップアップで設定してください。";
}

async function getStoredSyncLimit() {
  const { syncLimit } = await chrome.storage.local.get("syncLimit");
  return normalizeDetailFetchLimit(syncLimit);
}

async function syncInCampusAssignments(options = {}) {
  const force = Boolean(options.force);

  if (!isInCampusPage()) {
    return {
      ok: false,
      error: "inCampusのページではありません。"
    };
  }

  if (isSyncing) {
    return {
      ok: true,
      skipped: true,
      reason: "このページですでに同期中のため、重複実行をスキップしました。"
    };
  }

  // Reserve the sync before awaiting storage; overlapping lifecycle events
  // must not both pass the in-flight check and fetch the same page.
  isSyncing = true;
  const syncStartedAt = Date.now();
  let syncLeaseToken = '';

  const status = {
    ok: false,
    startedAt: new Date().toISOString(),
    foundCount: 0,
    assignmentCount: 0,
    announcementCount: 0,
    submissionRecordCount: 0,
    sentCount: 0,
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    previewCount: 0,
    detailPageCount: 0,
    limit: 0,
    dryRun: false,
    items: [],
    errors: []
  };

  try {
    const settings = await chrome.storage.local.get([
      "autoSyncEnabled",
      "lastInCampusAutoSyncAt",
      "lastInCampusSyncAttemptAt",
      "lastInCampusPreviewSyncAt",
      "previewOnly",
      "syncLimit"
    ]);

    if (!force && settings.autoSyncEnabled === false) {
      return {ok: true, skipped: true, reason: "自動同期がOFFのためスキップしました。"};
    }

    const lastSyncAt = Number(settings.lastInCampusAutoSyncAt || 0);
    if (!force && lastSyncAt > 0 && Date.now() - lastSyncAt < AUTO_SYNC_INTERVAL_MS) {
      return {ok: true, skipped: true, reason: "短時間の連続同期を避けるためスキップしました。"};
    }
    const lastAttemptAt = Number(settings.lastInCampusSyncAttemptAt || 0);
    if (!force && lastAttemptAt > 0 && Date.now() - lastAttemptAt < FAILED_SYNC_RETRY_INTERVAL_MS) {
      return {ok: true, skipped: true, reason: '直前の読み取りから1分以内のためスキップしました。'};
    }

    const dryRun = Boolean(options.dryRun || settings.previewOnly);
    const limit = Object.prototype.hasOwnProperty.call(options, "limit")
      ? normalizeDetailFetchLimit(options.limit)
      : normalizeDetailFetchLimit(settings.syncLimit);
    status.limit = limit;
    status.dryRun = dryRun;
    if (!force && dryRun && Number(settings.lastInCampusPreviewSyncAt || 0) > 0 &&
      Date.now() - Number(settings.lastInCampusPreviewSyncAt) < AUTO_SYNC_INTERVAL_MS) {
      return {ok: true, skipped: true, reason: '短時間の連続プレビューを避けるためスキップしました。'};
    }
    const lease = await chrome.runtime.sendMessage({type: 'ACQUIRE_INCAMPUS_SYNC', force, dryRun});
    if (lease?.skipped) return {ok: true, skipped: true, reason: lease.reason};
    if (lease?.ok === false) throw new Error(lease.error || '同期を開始できませんでした。');
    syncLeaseToken = lease?.token || '';

    let hubConnectionStatus = {ok: true};
    if (!dryRun) {
      hubConnectionStatus = await getHubConnectionStatus();
    }

    if (!dryRun && !hubConnectionStatus?.ok) {
      const message = getHubConnectionError(hubConnectionStatus);
      status.skipped = !force;
      status.error = message;
      status.reason = message;
      status.errors.push(message);
      status.finishedAt = new Date().toISOString();
      status.elapsedMs = Date.now() - syncStartedAt;
      await chrome.storage.local.set({lastInCampusSyncAttemptAt: Date.now()});
      await saveSyncStatus(status);
      return status;
    }

    const updateListStartedAt = Date.now();
    const updateInfoHtml = await fetchInCampusHtml(toAbsoluteInCampusUrl(UPDATEINFO_PATH));
    status.updateListFetchMs = Date.now() - updateListStartedAt;
    const extractionStartedAt = Date.now();
    const extracted = await collectInCampusAssignmentsFromHtml(updateInfoHtml, limit);
    status.detailExtractionMs = Date.now() - extractionStartedAt;
    status.detailPageCount = extracted.detailPageCount || 0;
    status.eligibleCount = extracted.eligibleCount;
    status.skippedByLimitCount = extracted.skippedByLimitCount || 0;
    status.foundCount = extracted.foundCount;
    status.assignmentCount = extracted.assignmentCount;
    status.announcementCount = extracted.announcementCount;
    status.submissionRecordCount = extracted.submissionRecordCount;
    status.errors.push(...extracted.errors);

    if (dryRun) {
      status.previewCount = extracted.assignments.length;
      status.items = extracted.assignments.map(assignment => ({
        action: "preview",
        type: assignment.type || "assignment",
        title: assignment.title || "",
        courseName: assignment.courseName || "",
        pageUrl: assignment.pageUrl || "",
        assignmentKey: assignment.assignmentKey || ""
      }));
    } else if (extracted.assignments.length > 0) {
      const hubSaveStartedAt = Date.now();
      const response = await chrome.runtime.sendMessage({
        type: "POST_INCAMPUS_ASSIGNMENTS",
        assignments: extracted.assignments
      });
      status.hubSaveMs = Date.now() - hubSaveStartedAt;
      const results = response?.result?.results;

      if (!Array.isArray(results) || results.length !== extracted.assignments.length) {
        status.errors.push(response?.error || "GASから課題ごとの同期結果が返りませんでした。");
      } else {
        results.forEach((item, index) => {
          const assignment = extracted.assignments[index];
          if (item?.ok === false) {
            status.errors.push(`${assignment.title || assignment.pageUrl}: ${item.error || "送信失敗"}`);
            return;
          }

          if (item?.dryRun || item?.previewOnly) {
            status.previewOnly = true;
            status.previewCount++;
            status.items.push({action: "preview", type: assignment.type || "assignment", title: assignment.title || "", courseName: assignment.courseName || "", pageUrl: assignment.pageUrl || "", assignmentKey: assignment.assignmentKey || ""});
            return;
          }

          if (item?.unchanged) {
            status.unchangedCount++;
            status.items.push({action: "unchanged", type: assignment.type || "assignment", title: assignment.title || "", courseName: assignment.courseName || "", pageUrl: assignment.pageUrl || "", assignmentKey: assignment.assignmentKey || ""});
            return;
          }

          status.sentCount++;
          if (item?.updated) status.updatedCount++;
          else status.newCount++;
          status.items.push({
            action: item?.updated ? "updated" : "created",
            type: assignment.type || "assignment",
            title: assignment.title || "",
            courseName: assignment.courseName || "",
            pageUrl: assignment.pageUrl || "",
            assignmentKey: assignment.assignmentKey || ""
          });
        });
        if (!response?.ok && !status.errors.length) status.errors.push(response?.error || "同期に失敗しました。");
        if (response?.error && !status.errors.includes(response.error)) status.errors.push(response.error);
      }
    }

    if (status.previewCount > 0 && status.sentCount === 0 && status.errors.length === 0) {
      status.dryRun = true;
    }
    status.ok = status.errors.length === 0;
    status.finishedAt = new Date().toISOString();
    status.elapsedMs = Date.now() - syncStartedAt;

    // Manual sync also suppresses an immediate duplicate automatic sync.
    const timestamps = {lastInCampusSyncAttemptAt: Date.now()};
    if (status.ok && !status.dryRun && !status.previewOnly) timestamps.lastInCampusAutoSyncAt = Date.now();
    if (status.ok && status.dryRun) timestamps.lastInCampusPreviewSyncAt = Date.now();
    await chrome.storage.local.set(timestamps);
    await saveSyncStatus(status);

    return status;
  } catch (error) {
    status.ok = false;
    status.finishedAt = new Date().toISOString();
    status.elapsedMs = Date.now() - syncStartedAt;
    status.errors.push(String(error?.message || error));
    await chrome.storage.local.set({lastInCampusSyncAttemptAt: Date.now()});
    await saveSyncStatus(status);
    return status;
  } finally {
    if (syncLeaseToken) {
      try { await chrome.runtime.sendMessage({type: 'RELEASE_INCAMPUS_SYNC', token: syncLeaseToken}); } catch (_) {}
    }
    isSyncing = false;
  }
}

function renderAutoSyncResult(result) {
  if (result?.skipped) {
    showInCampusSyncDebug(result.reason || "同期をスキップしました。");
    return;
  }

  if (!result?.ok) {
    showInCampusSyncDebug(result?.errors?.[0] || result?.error || "同期に失敗しました。", true);
    return;
  }

  if (result.dryRun || result.previewOnly) {
    showInCampusSyncDebug(`プレビュー完了: 確認${result.previewCount || 0}件 / 送信${result.sentCount || 0}件`);
    return;
  }

  showInCampusSyncDebug(
    `自動同期完了: 検出${result.foundCount || 0}件 / 課題${result.assignmentCount || 0}件 / お知らせ${result.announcementCount || 0}件 / 提出${result.submissionRecordCount || 0}件`
  );
}

function saveFailedAutoSyncStatus(error) {
  const message = String(error?.message || error);

  showInCampusSyncDebug(message, true);
  saveSyncStatus({
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    foundCount: 0,
    assignmentCount: 0,
    announcementCount: 0,
    submissionRecordCount: 0,
    sentCount: 0,
    newCount: 0,
    updatedCount: 0,
    previewCount: 0,
    items: [],
    errors: [message]
  }).catch(() => {});
}
function scheduleHomeAutoSync(reason = "home") {
  if (!isInCampusHomePage()) {
    return;
  }

  window.clearTimeout(pendingHomeAutoSyncTimerId);
  pendingHomeAutoSyncTimerId = window.setTimeout(() => {
    pendingHomeAutoSyncTimerId = 0;

    if (!isInCampusHomePage()) {
      return;
    }

    syncInCampusAssignments({force: false, reason})
      .then(result => { if (!result?.skipped || result?.error) renderAutoSyncResult(result); })
      .catch(saveFailedAutoSyncStatus);
  }, INCAMPUS_AUTO_SYNC_START_DELAY_MS);
}

function checkNavigation(reason = "url-watch", allowSameUrl = false) {
  const currentUrl = location.href;

  if (!allowSameUrl && currentUrl === lastObservedUrl) {
    return;
  }

  lastObservedUrl = currentUrl;
  scheduleHomeAutoSync(reason);
}

function installFastNavigationHooks() {
  const notifyNavigation = (reason) => {
    window.setTimeout(() => {
      checkNavigation(reason, true);
    }, 0);
  };

  ["pushState", "replaceState"].forEach((methodName) => {
    const original = history[methodName];

    if (typeof original !== "function") {
      return;
    }

    history[methodName] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      notifyNavigation(`history-${methodName}`);
      return result;
    };
  });

  window.addEventListener("popstate", () => notifyNavigation("popstate"));
  window.addEventListener("hashchange", () => notifyNavigation("hashchange"));
}

function installAutoSyncWatcher() {
  installFastNavigationHooks();
  scheduleHomeAutoSync("initial");

  window.setInterval(() => {
    checkNavigation("url-watch");
  }, HOME_URL_WATCH_INTERVAL_MS);

  window.addEventListener("pageshow", () => {
    checkNavigation("pageshow", true);
  });

  window.addEventListener("focus", () => {
    checkNavigation("focus", true);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      checkNavigation("visibility", true);
    }
  });

  document.addEventListener("readystatechange", () => {
    checkNavigation("readystatechange", true);
  });

  window.addEventListener("load", () => {
    checkNavigation("load", true);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING_INCAMPUS_CONTENT") {
    sendResponse({
      ok: true,
      isInCampusPage: isInCampusPage(),
      isHomePage: isInCampusHomePage(),
      url: location.href
    });
    return false;
  }

  if (message?.type === "DEBUG_EXTRACT_INCAMPUS_PAYLOAD") {
    extractInCampusDebugPayload({
      limit: message.limit
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        source: "inCampus",
        debug: true,
        error: String(error?.message || error),
        pageUrl: location.href,
        records: [],
        requestBodyPreview: {
          action: "upsertInCampusAssignments",
          assignments: []
        },
        errors: [String(error?.message || error)]
      }));

    return true;
  }

  if (message?.type === "EXTRACT_INCAMPUS_ASSIGNMENT_FROM_PAGE") {
    try {
      sendResponse(extractInCampusAssignmentFromCurrentPage());
    } catch (error) {
      sendResponse({
        ok: false,
        error: String(error?.message || error)
      });
    }

    return false;
  }

  if (message?.type !== "RUN_INCAMPUS_SYNC") {
    return false;
  }

  syncInCampusAssignments({
    force: Boolean(message.force),
    limit: message.limit,
    dryRun: Boolean(message.dryRun)
  })
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      error: String(error?.message || error)
    }));

  return true;
});

if (!window[AUTO_SYNC_WATCHER_INSTALLED_KEY]) {
  window[AUTO_SYNC_WATCHER_INSTALLED_KEY] = true;
  installAutoSyncWatcher();
}
