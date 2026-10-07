const INCAMPUS_HOST = "ic.ss.senshu-u.ac.jp";
const INCAMPUS_ORIGIN = `https://${INCAMPUS_HOST}`;
const CLASSROOM_HOST = "classroom.google.com";
const CLASSROOM_ORIGIN = `https://${CLASSROOM_HOST}`;
const UPDATEINFO_PATH = "/updateinfo";
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const INCAMPUS_AUTO_SYNC_START_DELAY_MS = 0;
const CLASSROOM_AUTO_SYNC_START_DELAY_MS = 500;
const HOME_URL_WATCH_INTERVAL_MS = 250;
const DEFAULT_DETAIL_FETCH_LIMIT = 25;
const ALLOWED_DETAIL_FETCH_LIMITS = new Set([10, 25, 50]);
const AUTO_SYNC_WATCHER_INSTALLED_KEY = "__taskhubAutoSyncWatcherInstalled";
const CLASSROOM_COMPLETION_AUTO_SYNC_STORAGE_KEY = "lastClassroomCompletionAutoSyncAt";
const CLASSROOM_DUE_TIME_AUTO_SYNC_STORAGE_KEY = "lastClassroomDueTimeAutoSyncAt";
const CLASSROOM_HOME_AUTO_SYNC_STORAGE_KEY = "lastClassroomHomeAutoSyncAt";
const CLASSROOM_NOT_TURNED_IN_PATH = "/a/not-turned-in/all";
const CLASSROOM_TURNED_IN_PATH = "/a/turned-in/all";
const CLASSROOM_HOME_PATH = "/h";
const CLASSROOM_FRAME_LOAD_TIMEOUT_MS = 20000;
const CLASSROOM_FRAME_RENDER_WAIT_MS = 2500;
const CLASSROOM_FRAME_POLL_INTERVAL_MS = 300;

let isSyncing = false;
let isClassroomAutoSyncing = false;
let pendingHomeAutoSyncTimerId = 0;
let pendingClassroomAutoSyncTimerId = 0;
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

  return normalizeText(element.innerText || element.textContent);
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

    if (url.protocol !== "https:" || url.hostname !== INCAMPUS_HOST) {
      return "";
    }

    url.hash = "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function toAbsoluteClassroomUrl(path) {
  const rawPath = String(path || "").trim();

  if (!rawPath) {
    return "";
  }

  try {
    const url = new URL(rawPath, CLASSROOM_ORIGIN);

    if (url.protocol !== "https:" || url.hostname !== CLASSROOM_HOST) {
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

function isClassroomPage() {
  return location.hostname === CLASSROOM_HOST;
}

function isClassroomHomePath(pathname) {
  const normalizedPath = String(pathname || "").replace(/\/+$/, "");

  return normalizedPath === "" ||
    normalizedPath === CLASSROOM_HOME_PATH ||
    /^\/u\/\d+(?:\/h)?$/.test(normalizedPath);
}

function isClassroomHomePage() {
  return isClassroomPage() && isClassroomHomePath(location.pathname);
}

function isClassroomTurnedInPage() {
  return isClassroomPage() && location.pathname.includes("/a/turned-in");
}

function isClassroomNotTurnedInPage() {
  return isClassroomPage() && location.pathname.includes("/a/not-turned-in");
}

function parseHtml(html) {
  return new DOMParser().parseFromString(String(html || ""), "text/html");
}

async function fetchInCampusHtml(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`${url} の取得に失敗しました。status=${response.status}`);
  }

  return response.text();
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

function extractSubmissionTitle(text) {
  const normalized = normalizeText(text);
  const patterns = [
    /課題\s*[（(]([^）)]+)[）)]\s*を提出しました/,
    /課題\s*[「『]([^」』]+)[」』]\s*を提出しました/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);

    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }

  return "";
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

  return getUpdateInfoRows(doc)
    .map((row) => {
      const button = row.querySelector?.("button.updateInfoUrl") || row;
      const rowText = getElementText(row);
      const detailUrl = extractButtonUrl(button);

      const spans = Array.from(button?.querySelectorAll?.("span") || [])
        .map((span) => normalizeText(span.textContent))
        .filter(Boolean);
      const courseName = parseCourseNameFromUpdateText(rowText, spans);
      const updateText = normalizeText(spans.length > 1 ? spans.slice(1).join("\n") : rowText);
      const updateKind = getInCampusUpdateKind(updateText);
      if (!updateKind) return null;
      const submissionTitle = updateKind === 'assignment' && /を提出しました/.test(updateText)
        ? extractTitleFromUpdateText(updateText) : '';
      const titleFromUpdate = submissionTitle || extractTitleFromUpdateText(updateText);
      const kind = submissionTitle ? "submissionRecord" : updateKind;

      if (kind !== "submissionRecord" && !detailUrl) {
        return null;
      }

      const notification = {
        kind,
        idnumber: getInputValue(row, ["idnumber", "idNumber"]),
        reportId: getInputValue(row, ["contentId", "reportId"]),
        updateInfoId: getInputValue(row, ["updateInfoId"]),
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
        detailUrl: detailUrl || buildUpdateInfoFallbackUrl(getInputValue(row, ["updateInfoId"]), updateText)
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
    .split(/[～〜~－–—]/)
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

  if (!title || (!body && !periodText)) {
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
  const assignment = extractAssignmentFromDetailHtml(
    document.documentElement.outerHTML,
    pageUrl,
    {
      detailUrl: pageUrl,
      assignmentKey: pageUrl
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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function expandClassroomSections(root = document, onExpanded) {
  if (!root?.querySelectorAll) {
    return 0;
  }

  const sectionNamePattern = /期限なし|早期完了|今週|次の週|先週|それ以前|それ以降/;
  const findCandidates = () => Array.from(root.querySelectorAll("[aria-expanded='false'], button, [role='button']"))
    .filter((element) => {
      if (element.closest("a") || element.disabled || element.getAttribute("aria-disabled") === "true") {
        return false;
      }

      const text = getElementText(element);
      const label = element.getAttribute("aria-label") || "";
      const expanded = element.getAttribute("aria-expanded");
      const knownSection = sectionNamePattern.test(text) || sectionNamePattern.test(label);

      return knownSection && (expanded === "false" || Boolean(element.querySelector("[aria-expanded='false']")));
    });
  const getSectionNames = () => findCandidates().map((element) =>
    (getElementText(element) + " " + (element.getAttribute("aria-label") || "")).match(sectionNamePattern)?.[0]
  ).filter(Boolean);
  let sectionNames = [...new Set(getSectionNames())];
  let clickedCount = 0;
  const expandVisibleCards = async (allowUnready = false) => {
    // Classroom initially shows only five cards per section, even when expanded.
    // Wait for the current section before looking for its "show all" control.
    if (onExpanded) await onExpanded({ allowUnready });
    const seen = new Set();
    for (let pass = 0; pass < 20; pass++) {
      const showAllButtons = Array.from(root.querySelectorAll("button, [role='button']"))
        .filter((element) => !seen.has(element) && !element.disabled &&
          element.getAttribute("aria-disabled") !== "true" && !element.closest("a") &&
          /^(?:すべて表示|すべてを表示|show all)$/i.test(getElementText(element)));
      if (!showAllButtons.length) break;
      for (const element of showAllButtons) {
        seen.add(element);
        element.click();
        clickedCount++;
      }
      await sleep(500);
      if (onExpanded) await onExpanded();
    }
  };
  await expandVisibleCards(sectionNames.length > 0);
  sectionNames = [...new Set(sectionNames.concat(getSectionNames()))];
  for (const sectionName of sectionNames) {
    // Re-resolve after rendering: changing sections can replace the previous DOM.
    const element = findCandidates().find((candidate) =>
      (getElementText(candidate) + " " + (candidate.getAttribute("aria-label") || "")).includes(sectionName)
    );
    if (!element) continue;
    element.click();
    clickedCount++;
    await sleep(500);
    await expandVisibleCards();
  }

  return clickedCount;
}

async function collectClassroomRecordsFromDocument(mode, root, pageUrl) {
  const records = new Map();
  let successfulExtraction = false;
  let lastError = "Classroomの課題一覧を確認できませんでした。";
  const collect = async ({ allowUnready = false } = {}) => {
    const startedAt = Date.now();
    let extraction;
    do {
      extraction = mode === "completion"
        ? extractClassroomCompletionRecordsFromDocument(root, pageUrl)
        : extractClassroomDueTimeRecordsFromDocument(root, pageUrl);
      if (extraction.ok) break;
      lastError = extraction.error || lastError;
      // Before the first section is opened there may be no cards yet.
      if (allowUnready && getClassroomAssignmentAnchors(root).length === 0) return;
      await sleep(CLASSROOM_FRAME_POLL_INTERVAL_MS);
    } while (Date.now() - startedAt < CLASSROOM_FRAME_LOAD_TIMEOUT_MS);
    if (!extraction.ok) {
      throw new Error(lastError);
    }
    successfulExtraction = true;
    extraction.records.forEach((record) => records.set(record.classroomUrl, record));
  };
  let expandedSectionCount = 0;
  try {
    expandedSectionCount = await expandClassroomSections(root, collect);
  } catch (error) {
    return { ok: false, records: [...records.values()], pageUrl, expandedSectionCount,
      error: String(error?.message || error) };
  }
  return {
    ok: successfulExtraction, records: [...records.values()], pageUrl,
    expandedSectionCount, error: successfulExtraction ? "" : lastError
  };
}

function getClassroomAssignmentAnchors(root = document) {
  if (!root?.querySelectorAll) {
    return [];
  }

  const candidates = Array.from(root.querySelectorAll("a[href], a[data-focus-id], [data-href], [data-url], [data-course-id][data-stream-item-id]"));
  const seen = new Set();

  return candidates.filter((element) => {
    const classroomUrl = getClassroomAssignmentUrlFromElement(element);

    if (!classroomUrl || seen.has(classroomUrl)) {
      return false;
    }

    seen.add(classroomUrl);
    return true;
  });
}

function normalizeClassroomAssignmentUrl(value) {
  const classroomUrl = toAbsoluteClassroomUrl(value);

  if (!classroomUrl) {
    return "";
  }

  try {
    const url = new URL(classroomUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    const pathMatch = normalizedPath.match(/(\/c\/[^/]+\/a\/[^/]+)(?:\/details)?$/);

    if (!pathMatch) {
      return "";
    }

    url.pathname = `${pathMatch[1]}/details`;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function getClassroomElementUrlCandidates(element) {
  const candidates = [];
  const addCandidate = (value) => {
    const text = String(value || "").trim();

    if (text) {
      candidates.push(text);
    }
  };
  const addNodeAttributes = (node) => {
    if (!node?.getAttribute) {
      return;
    }

    ["href", "data-focus-id", "data-href", "data-url"].forEach((name) => {
      addCandidate(node.getAttribute(name));
    });
  };

  addNodeAttributes(element);
  addNodeAttributes(element.closest?.("a[href], a[data-focus-id], [data-href], [data-url]"));

  Array.from(element.querySelectorAll?.("a[href], a[data-focus-id], [data-href], [data-url]") || [])
    .forEach(addNodeAttributes);

  return candidates;
}

function getClassroomAssignmentUrlFromElement(element) {
  for (const candidate of getClassroomElementUrlCandidates(element)) {
    const classroomUrl = normalizeClassroomAssignmentUrl(candidate);

    if (classroomUrl) {
      return classroomUrl;
    }
  }

  return "";
}

function findClassroomCardRoot(element) {
  return element.closest?.("[data-course-id][data-stream-item-id]") ||
    element.querySelector?.("[data-course-id][data-stream-item-id]") ||
    element.closest?.("[data-course-id], [data-stream-item-id], [role='listitem'], article, li") ||
    element;
}

function getClassroomCardAttribute(root, fallback, name) {
  return root?.getAttribute?.(name) ||
    root?.querySelector?.(`[${name}]`)?.getAttribute(name) ||
    fallback?.getAttribute?.(name) ||
    fallback?.closest?.(`[${name}]`)?.getAttribute(name) ||
    "";
}

function isClassroomIconText(text) {
  return /^(assignment|article|quiz|draft|description|task|check_circle|grading|school)$/i.test(normalizeText(text));
}

function splitClassroomTextFragments(text) {
  return normalizeText(text)
    .split("\n")
    .map((fragment) => normalizeText(fragment))
    .filter(Boolean);
}

function getClassroomCardTexts(root, anchor) {
  const textNodes = Array.from(root?.querySelectorAll?.("h1, h2, h3, [role='heading'], [aria-level], p, span") || [])
    .filter((node) => !node.closest?.(".google-symbols, .material-icons, [aria-hidden='true']"))
    .flatMap((node) => splitClassroomTextFragments(node.textContent))
    .filter((text) => text && !isClassroomIconText(text));
  const fallbackTexts = splitClassroomTextFragments(
    anchor?.getAttribute?.("aria-label") ||
    anchor?.textContent ||
    root?.textContent ||
    ""
  )
    .filter((text) => text && !isClassroomIconText(text));
  const seen = new Set();

  return textNodes.concat(fallbackTexts).filter((text) => {
    if (seen.has(text)) {
      return false;
    }

    seen.add(text);
    return true;
  });
}

function isClassroomDueText(text) {
  const normalized = normalizeText(text);
  const dayPattern = "(?:今日|明日|昨日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|\\d{1,2}月\\s*\\d{1,2}日)";

  if (!normalized) {
    return false;
  }

  if (/^(?:期限\s*[：:]?\s*)?期限なし$/.test(normalized)) {
    return true;
  }

  if (/^\d{1,2}:\d{2}$/.test(normalized)) {
    return true;
  }

  if (new RegExp(`^(?:期限\\s*[：:]?\\s*)?${dayPattern}(?:\\s+\\d{1,2}:\\d{2})?$`).test(normalized)) {
    return true;
  }

  return false;
}

function getClassroomStatusLabel(text) {
  const normalized = normalizeText(text);
  const exactMatch = normalized.match(/^(完了|提出済み|未提出|割り当て済み|採点済み|返却済み)$/);
  const gluedMatch = normalized.match(/^(完了|提出済み|未提出|割り当て済み|採点済み|返却済み)(?=[A-Za-z][A-Za-z0-9_-]{3,}$)/);

  return exactMatch?.[1] || gluedMatch?.[1] || "";
}

function isClassroomStatusText(text) {
  return Boolean(getClassroomStatusLabel(text));
}

function isClassroomCompletedStatusText(text) {
  return /^(完了|提出済み|採点済み|返却済み)$/.test(getClassroomStatusLabel(text));
}

function isClassroomIncompleteStatusText(text) {
  return /^(未提出|割り当て済み)$/.test(getClassroomStatusLabel(text));
}

function shouldIncludeClassroomCompletionCard(card) {
  const statusText = normalizeText(card?.statusText || "");

  if (!statusText) {
    return true;
  }

  return isClassroomCompletedStatusText(statusText) && !isClassroomIncompleteStatusText(statusText);
}

function findClassroomStatusText(texts) {
  return texts
    .map(getClassroomStatusLabel)
    .find(Boolean) || "";
}

function isClassroomUiLabelText(text) {
  return /^(Google Classroom|Classroom|ToDo|すべてのクラス|期限なし|早期完了|今週|次の週|先週|それ以前|\d+)$/.test(normalizeText(text));
}

function isLikelyClassroomAssignmentTitleText(text) {
  return /課題|宿題|レポート|リフレクション|リアクション|アクティビティ|テスト|クイズ|Quiz|提出|問題|予習|復習|事前|事後|フォーム|アンケート|画面収録/i.test(normalizeText(text));
}

function getClassroomAssignmentCandidateTexts(texts, dueText) {
  const seen = new Set();

  return texts
    .map((text) => normalizeText(text))
    .filter((text) => {
      if (
        !text ||
        seen.has(text) ||
        text === dueText ||
        isClassroomIconText(text) ||
        isClassroomDueText(text) ||
        isClassroomStatusText(text) ||
        isClassroomUiLabelText(text)
      ) {
        return false;
      }

      seen.add(text);
      return true;
    });
}

function findClassroomTitleText(texts, anchor, dueText) {
  const anchorTexts = splitClassroomTextFragments(anchor?.textContent || "")
    .filter((text) => text && !isClassroomIconText(text));
  const candidates = getClassroomAssignmentCandidateTexts(texts.concat(anchorTexts), dueText);
  const likelyTitle = candidates.find(isLikelyClassroomAssignmentTitleText);

  return likelyTitle || candidates[0] || "";
}

function findClassroomCourseNameText(texts, title, dueText, itemRoot, anchor) {
  const courseName = normalizeText(getClassroomCardAttribute(itemRoot, anchor, "data-course-name"));

  if (
    courseName &&
    courseName !== title &&
    !isClassroomDueText(courseName) &&
    !isClassroomStatusText(courseName) &&
    !isClassroomUiLabelText(courseName)
  ) {
    return courseName;
  }

  const candidates = getClassroomAssignmentCandidateTexts(texts, dueText)
    .filter((text) => text !== title);
  const likelyCourse = candidates.find((text) => !isLikelyClassroomAssignmentTitleText(text));

  return likelyCourse || candidates[0] || "";
}

function extractClassroomCardData(anchor) {
  const classroomUrl = getClassroomAssignmentUrlFromElement(anchor);

  if (!classroomUrl) {
    return null;
  }

  const itemRoot = findClassroomCardRoot(anchor);
  const textNodes = getClassroomCardTexts(itemRoot, anchor);
  const dueText = findClassroomDueText(textNodes);
  const statusText = findClassroomStatusText(textNodes);
  const title = findClassroomTitleText(textNodes, anchor, dueText);
  const courseName = findClassroomCourseNameText(textNodes, title, dueText, itemRoot, anchor);

  return {
    title,
    courseName,
    classroomUrl,
    pageUrl: classroomUrl,
    courseId: getClassroomCardAttribute(itemRoot, anchor, "data-course-id"),
    streamItemId: getClassroomCardAttribute(itemRoot, anchor, "data-stream-item-id"),
    submissionId: getClassroomCardAttribute(itemRoot, anchor, "data-submission-id"),
    statusText,
    dueText
  };
}

function findClassroomDueText(texts) {
  const normalizedTexts = texts
    .map((text) => normalizeText(text))
    .filter(Boolean);
  const compactPairIndex = normalizedTexts.findIndex((text, index) =>
    /^(今日|明日|昨日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|\d{1,2}月\d{1,2}日)$/.test(text) &&
    /^\d{1,2}:\d{2}$/.test(normalizedTexts[index + 1] || "")
  );

  if (compactPairIndex !== -1) {
    return `${normalizedTexts[compactPairIndex]} ${normalizedTexts[compactPairIndex + 1]}`;
  }

  return normalizedTexts.find(isClassroomDueText) || "";
}

function parseClassroomDueText(dueText) {
  const text = normalizeText(dueText);
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  const dueTime = timeMatch
    ? `${String(Number(timeMatch[1])).padStart(2, "0")}:${timeMatch[2]}`
    : "";
  let dueDate = "";
  const today = new Date();
  const targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const weekdayMap = {
    日曜日: 0,
    月曜日: 1,
    火曜日: 2,
    水曜日: 3,
    木曜日: 4,
    金曜日: 5,
    土曜日: 6
  };
  const setDateString = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    dueDate = `${year}-${month}-${day}`;
  };

  if (/今日/.test(text)) {
    setDateString(targetDate);
  } else if (/明日/.test(text)) {
    targetDate.setDate(targetDate.getDate() + 1);
    setDateString(targetDate);
  } else {
    const weekday = Object.keys(weekdayMap).find((label) => text.includes(label));
    const monthDayMatch = text.match(/(\d{1,2})月\s*(\d{1,2})日/);

    if (monthDayMatch) {
      const date = new Date(today.getFullYear(), Number(monthDayMatch[1]) - 1, Number(monthDayMatch[2]));

      if (date.getTime() < targetDate.getTime() - 180 * 24 * 60 * 60 * 1000) {
        date.setFullYear(date.getFullYear() + 1);
      }

      setDateString(date);
    } else if (weekday) {
      const diff = (weekdayMap[weekday] - targetDate.getDay() + 7) % 7;
      targetDate.setDate(targetDate.getDate() + diff);
      setDateString(targetDate);
    }
  }

  let dueAt = "";

  if (dueDate && dueTime) {
    dueAt = `${dueDate}T${dueTime}:00`;
  }

  return {
    dueText: text,
    dueDate,
    dueTime,
    dueAt
  };
}

function extractClassroomCompletionRecordsFromDocument(root = document, pageUrl = location.href) {
  const readiness = getClassroomDocumentReadiness(root, "completion", pageUrl);
  if (!readiness.ok) return { ...readiness, records: [], pageUrl };
  const anchors = getClassroomAssignmentAnchors(root);
  const seen = new Set();
  const records = [];

  anchors.forEach((anchor) => {
    const card = extractClassroomCardData(anchor);

    if (!card || seen.has(card.classroomUrl)) {
      return;
    }

    if (!card.title && !card.courseId && !card.streamItemId) {
      return;
    }

    if (!shouldIncludeClassroomCompletionCard(card)) {
      return;
    }

    seen.add(card.classroomUrl);
    records.push({
      source: "Google Classroom",
      type: "completionRecord",
      status: "完了",
      title: card.title,
      courseName: card.courseName,
      classroomUrl: card.classroomUrl,
      pageUrl: card.classroomUrl,
      courseId: card.courseId,
      streamItemId: card.streamItemId,
      submissionId: card.submissionId,
      statusText: card.statusText,
      dueText: card.dueText,
      completedAt: new Date().toISOString(),
      extractedAt: new Date().toISOString()
    });
  });

  return {
    ok: true,
    records,
    pageUrl
  };
}

function extractClassroomCompletionRecordsFromPage() {
  if (!isClassroomPage()) {
    return {
      ok: false,
      error: "Google Classroomのページではありません。"
    };
  }

  if (!isClassroomTurnedInPage()) {
    return {
      ok: false,
      error: "Google Classroomの「完了」ページで実行してください。"
    };
  }

  return extractClassroomCompletionRecordsFromDocument(document, location.href);
}

function extractClassroomDueTimeRecordsFromDocument(root = document, pageUrl = location.href) {
  const readiness = getClassroomDocumentReadiness(root, "dueTime", pageUrl);
  if (!readiness.ok) return { ...readiness, records: [], pageUrl };
  const anchors = getClassroomAssignmentAnchors(root);
  const seen = new Set();
  const records = [];

  anchors.forEach((anchor) => {
    const card = extractClassroomCardData(anchor);

    if (!card || seen.has(card.classroomUrl)) {
      return;
    }

    const due = parseClassroomDueText(card.dueText);

    if (!card.title && !card.courseId && !card.streamItemId) {
      return;
    }

    if (!due.dueTime) {
      return;
    }

    seen.add(card.classroomUrl);
    records.push({
      source: "Google Classroom",
      type: "dueTimeRecord",
      title: card.title,
      courseName: card.courseName,
      classroomUrl: card.classroomUrl,
      pageUrl: card.classroomUrl,
      courseId: card.courseId,
      streamItemId: card.streamItemId,
      submissionId: card.submissionId,
      statusText: card.statusText,
      dueText: due.dueText,
      dueDate: due.dueDate,
      dueTime: due.dueTime,
      dueAt: due.dueAt,
      extractedAt: new Date().toISOString()
    });
  });

  return {
    ok: true,
    records,
    pageUrl
  };
}

function extractClassroomDueTimeRecordsFromPage() {
  if (!isClassroomPage()) {
    return {
      ok: false,
      error: "Google Classroomのページではありません。"
    };
  }

  if (!isClassroomNotTurnedInPage()) {
    return {
      ok: false,
      error: "Google Classroomの「未提出」ページで実行してください。"
    };
  }

  return extractClassroomDueTimeRecordsFromDocument(document, location.href);
}

async function postAssignment(assignment) {
  return chrome.runtime.sendMessage({
    type: "POST_INCAMPUS_ASSIGNMENT",
    assignment
  });
}

async function postClassroomCompletionRecords(records) {
  return chrome.runtime.sendMessage({
    type: "POST_CLASSROOM_COMPLETION_RECORDS",
    records
  });
}

async function postClassroomDueTimeRecords(records) {
  return chrome.runtime.sendMessage({
    type: "POST_CLASSROOM_DUE_TIME_RECORDS",
    records
  });
}

function buildClassroomDebugPayload(mode, extraction, pageUrl) {
  const action = mode === "completion"
    ? "completeClassroomAssignments"
    : "updateClassroomDueTimes";
  const records = Array.isArray(extraction?.records) ? extraction.records : [];

  return {
    ok: Boolean(extraction?.ok),
    mode,
    action,
    pageUrl: extraction?.pageUrl || pageUrl || "",
    foundCount: records.length,
    records,
    requestBodyPreview: {
      action,
      records
    },
    error: extraction?.error || ""
  };
}

async function extractClassroomDebugPayloadForMode(mode, root = document, pageUrl = location.href) {
  if (mode === "completion") {
    return buildClassroomDebugPayload(
      mode,
      await collectClassroomRecordsFromDocument(mode, root, pageUrl),
      pageUrl
    );
  }

  if (mode === "dueTime") {
    return buildClassroomDebugPayload(
      mode,
      await collectClassroomRecordsFromDocument(mode, root, pageUrl),
      pageUrl
    );
  }

  return {
    ok: false,
    mode,
    action: "",
    pageUrl,
    foundCount: 0,
    records: [],
    requestBodyPreview: null,
    error: "Classroom完了・未提出・ホームのいずれかで実行してください。"
  };
}

async function extractClassroomDebugPayload() {
  if (!isClassroomPage()) {
    return {
      ok: false,
      source: "Google Classroom",
      debug: true,
      error: "Google Classroomのページではありません。",
      pageUrl: location.href,
      payloads: []
    };
  }

  const mode = getClassroomAutoSyncMode();

  if (mode === "completion" || mode === "dueTime") {
    const payload = await extractClassroomDebugPayloadForMode(mode, document, location.href);

    return {
      ok: payload.ok,
      source: "Google Classroom",
      debug: true,
      mode,
      pageUrl: location.href,
      extractedAt: new Date().toISOString(),
      payloads: [payload],
      totalRecordCount: payload.foundCount,
      errors: payload.error ? [payload.error] : []
    };
  }

  if (mode === "home") {
    const payloads = [];
    const errors = [];

    for (const hiddenMode of ["dueTime", "completion"]) {
      try {
        const framePage = await loadClassroomDocumentInHiddenFrame(hiddenMode);

        try {
          payloads.push(await extractClassroomDebugPayloadForMode(hiddenMode, framePage.doc, framePage.url));
        } finally {
          framePage.cleanup();
        }
      } catch (error) {
        errors.push(`${getClassroomAutoSyncModeLabel(hiddenMode)}: ${String(error?.message || error)}`);
      }
    }

    return {
      ok: payloads.length > 0 && payloads.every((payload) => payload.ok) && errors.length === 0,
      source: "Google Classroom",
      debug: true,
      mode,
      pageUrl: location.href,
      extractedAt: new Date().toISOString(),
      payloads,
      totalRecordCount: payloads.reduce((sum, payload) => sum + Number(payload.foundCount || 0), 0),
      errors
    };
  }

  return {
    ok: false,
    source: "Google Classroom",
    debug: true,
    mode: mode || "unsupported",
    pageUrl: location.href,
    extractedAt: new Date().toISOString(),
    payloads: [],
    totalRecordCount: 0,
    errors: ["Classroom完了・未提出・ホームのいずれかで実行してください。"]
  };
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
      action: "upsertInCampusAssignment",
      requests: []
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
    const notifications = dedupeNotifications(parseReportNotifications(updateInfoHtml))
      .slice(0, limit);

    payload.foundCount = notifications.length;

    for (const notification of notifications) {
      try {
        let assignment = null;

        if (notification.kind === "submissionRecord") {
          assignment = buildSubmissionRecordAssignment(notification);
        } else if (notification.kind === "announcement") {
          assignment = buildInCampusAnnouncement(notification);
        } else {
          const detailHtml = await fetchInCampusHtml(notification.detailUrl);
          assignment = extractAssignmentFromDetailHtml(
            detailHtml,
            notification.detailUrl,
            notification
          );
        }

        if (!assignment) {
          payload.errors.push(`${notification.detailUrl}: 課題情報を抽出できませんでした。`);
          continue;
        }

        if (assignment.type === "submissionRecord") {
          payload.submissionRecordCount++;
        } else if (assignment.type === "announcement") {
          payload.announcementCount++;
        } else {
          payload.assignmentCount++;
        }

        payload.records.push(assignment);
      } catch (error) {
        payload.errors.push(String(error?.message || error));
      }
    }

    payload.recordCount = payload.records.length;
    payload.requestBodyPreview.requests = payload.records.map((assignment) => ({
      action: "upsertInCampusAssignment",
      assignment
    }));
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

async function isAutoSyncEnabled() {
  const { autoSyncEnabled } = await chrome.storage.local.get("autoSyncEnabled");
  return autoSyncEnabled !== false;
}

async function isClassroomAutoSyncEnabled() {
  const { classroomAutoSyncEnabled } = await chrome.storage.local.get("classroomAutoSyncEnabled");
  return classroomAutoSyncEnabled !== false;
}

async function isSyncPreviewOnly(options = {}) {
  const { previewOnly } = await chrome.storage.local.get("previewOnly");
  return Boolean(options.dryRun || previewOnly);
}

async function getStoredSyncLimit() {
  const { syncLimit } = await chrome.storage.local.get("syncLimit");
  return normalizeDetailFetchLimit(syncLimit);
}

async function shouldSkipAutoSync(force) {
  if (force) {
    return false;
  }

  const { lastInCampusAutoSyncAt } = await chrome.storage.local.get("lastInCampusAutoSyncAt");
  const lastTime = Number(lastInCampusAutoSyncAt || 0);

  return lastTime > 0 && Date.now() - lastTime < AUTO_SYNC_INTERVAL_MS;
}

function getClassroomAutoSyncMode() {
  if (isClassroomHomePage()) {
    return "home";
  }

  if (isClassroomNotTurnedInPage()) {
    return "dueTime";
  }

  if (isClassroomTurnedInPage()) {
    return "completion";
  }

  return "";
}

function getClassroomAutoSyncModeLabel(mode) {
  if (mode === "completion") {
    return "完了";
  }

  if (mode === "dueTime") {
    return "期限";
  }

  if (mode === "home") {
    return "ホーム";
  }

  return "Classroom";
}

function getClassroomAutoSyncStorageKey(mode) {
  if (mode === "completion") {
    return CLASSROOM_COMPLETION_AUTO_SYNC_STORAGE_KEY;
  }

  if (mode === "dueTime") {
    return CLASSROOM_DUE_TIME_AUTO_SYNC_STORAGE_KEY;
  }

  if (mode === "home") {
    return CLASSROOM_HOME_AUTO_SYNC_STORAGE_KEY;
  }

  return "";
}

function getClassroomAutoSyncPath(mode) {
  if (mode === "dueTime") {
    return CLASSROOM_NOT_TURNED_IN_PATH;
  }

  if (mode === "completion") {
    return CLASSROOM_TURNED_IN_PATH;
  }

  return CLASSROOM_HOME_PATH;
}

function getClassroomAutoSyncUrl(mode) {
  return CLASSROOM_ORIGIN + getClassroomAutoSyncPath(mode);
}

async function shouldSkipClassroomAutoSync(mode, force) {
  if (force) {
    return false;
  }

  const storageKey = getClassroomAutoSyncStorageKey(mode);

  if (!storageKey) {
    return true;
  }

  const stored = await chrome.storage.local.get(storageKey);
  const lastTime = Number(stored[storageKey] || 0);

  return lastTime > 0 && Date.now() - lastTime < AUTO_SYNC_INTERVAL_MS;
}

async function markClassroomAutoSyncCompleted(mode) {
  const storageKey = getClassroomAutoSyncStorageKey(mode);

  if (!storageKey) {
    return;
  }

  await chrome.storage.local.set({
    [storageKey]: Date.now()
  });
}

function createHiddenClassroomFrame(url) {
  const frame = document.createElement("iframe");

  frame.src = url;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.position = "fixed";
  frame.style.left = "-10000px";
  frame.style.top = "0";
  frame.style.width = "1280px";
  frame.style.height = "900px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.border = "0";
  frame.style.zIndex = "-1";

  return frame;
}

function getFrameDocument(frame) {
  try {
    return frame.contentDocument || frame.contentWindow?.document || null;
  } catch (_) {
    return null;
  }
}

function isExpectedClassroomUrl(value, mode, allowCourseFilter = false) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/u\/\d+(?=\/)/, "").replace(/\/+$/, "");
    const expectedPath = getClassroomAutoSyncPath(mode);
    const prefix = expectedPath.replace(/all$/, "");
    return url.protocol === "https:" && url.hostname === CLASSROOM_HOST &&
      (path === expectedPath || (allowCourseFilter && path.startsWith(prefix) &&
        /^[A-Za-z0-9_-]+$/.test(path.slice(prefix.length))));
  } catch (_) {
    return false;
  }
}

function getClassroomDocumentReadiness(doc, mode, pageUrl) {
  // Navigation labels alone occur while the app is still loading.
  const actualUrl = doc?.location?.href || doc?.URL || pageUrl;
  if (!doc?.body || !isExpectedClassroomUrl(actualUrl, mode, true) ||
      (doc.readyState && !["interactive", "complete"].includes(doc.readyState))) {
    return { ok: false, error: "Classroomの対象ページの読み込みを確認できませんでした。" };
  }
  const activeLoading = Array.from(doc.querySelectorAll?.('[aria-busy="true"], [role="progressbar"]') || [])
    .some((element) => !element.hidden &&
      !element.closest?.('[hidden], [aria-hidden="true"]') &&
      (!element.getClientRects || element.getClientRects().length > 0));
  if (activeLoading) {
    return { ok: false, error: "Classroomの課題一覧を読み込み中です。" };
  }
  if (getClassroomAssignmentAnchors(doc).length > 0) {
    return { ok: true, empty: false };
  }
  const bodyText = getElementText(doc.querySelector?.('main, [role="main"]') || doc.body);
  const explicitEmpty = /ToDo\s*リストには何もありません|(?:提出済み|完了した|未提出|予定されている|割り当てられた)(?:の)?課題(?:は|が)ありません|課題(?:は|が)ありません|すべて(?:の課題が)?完了しました|すべて提出済み|no (?:completed |turned.in |assigned |upcoming )?(?:work|assignments)(?: due(?: soon)?| to do)?|you(?:'|’)re all caught up/i.test(bodyText);
  return explicitEmpty
    ? { ok: true, empty: true }
    : { ok: false, error: "Classroomの課題一覧または課題なしの表示を確認できませんでした。" };
}

async function waitForHiddenClassroomFrame(frame, mode) {
  const startedAt = Date.now();
  let readySince = 0;
  let readyDocument = null;

  while (Date.now() - startedAt < CLASSROOM_FRAME_LOAD_TIMEOUT_MS) {
    const doc = getFrameDocument(frame);
    const href = (() => {
      try {
        return frame.contentWindow?.location?.href || "";
      } catch (_) {
        return "";
      }
    })();
    if (isExpectedClassroomUrl(href, mode) && doc?.body &&
        !getClassroomDocumentReadiness(doc, mode, href).ok &&
        doc.querySelectorAll("[aria-expanded='false']").length > 0) {
      await expandClassroomSections(doc);
    }
    if (isExpectedClassroomUrl(href, mode) && getClassroomDocumentReadiness(doc, mode, href).ok) {
      if (readyDocument !== doc) {
        readyDocument = doc;
        readySince = Date.now();
      }
      if (Date.now() - readySince >= CLASSROOM_FRAME_RENDER_WAIT_MS) return doc;
    } else {
      readyDocument = null;
      readySince = 0;
    }

    await sleep(CLASSROOM_FRAME_POLL_INTERVAL_MS);
  }

  throw new Error("Classroomの課題一覧の読み込みが時間内に完了しませんでした。未提出・完了ページを開いて再実行してください。");
}

async function loadClassroomDocumentInHiddenFrame(mode) {
  const url = getClassroomAutoSyncUrl(mode);
  const frame = createHiddenClassroomFrame(url);

  document.documentElement.appendChild(frame);

  try {
    const doc = await waitForHiddenClassroomFrame(frame, mode);

    return {
      doc,
      url: frame.contentWindow.location.href,
      cleanup: () => frame.remove()
    };
  } catch (error) {
    frame.remove();
    throw error;
  }
}

function mergeClassroomHubResults(items, hubResults) {
  if (!Array.isArray(items) || !Array.isArray(hubResults)) {
    return items;
  }

  const resultByUrl = new Map();
  const resultByIds = new Map();
  const normalizeUrl = (value) => String(value || "").replace(/\/+$/, "");
  const buildIdsKey = (value) => {
    const match = normalizeUrl(value).match(/\/c\/([^/]+)\/a\/([^/]+)\/details$/);

    return match ? `${match[1]}:${match[2]}` : "";
  };

  hubResults.forEach((result) => {
    const url = normalizeUrl(result.classroomUrl || result.pageUrl);
    const idsKey = buildIdsKey(url);

    if (url) {
      resultByUrl.set(url, result);
    }

    if (idsKey) {
      resultByIds.set(idsKey, result);
    }
  });

  return items.map((item, index) => {
    const url = normalizeUrl(item.pageUrl || item.classroomUrl);
    const idsKey = buildIdsKey(url);
    const result = hubResults.find((entry) => entry.recordIndex === index) || resultByUrl.get(url) || resultByIds.get(idsKey);

    if (!result) {
      return item;
    }

    return {
      ...item,
      action: result.failed ? "failed" : result.preview ? "preview" : result.created ? "created" : result.matched ? item.action : "unmatched",
      matched: Boolean(result.matched),
      created: Boolean(result.created),
      row: result.row || "",
      reason: result.reason || ""
    };
  });
}

function applyClassroomPostResult(status, response, fallbackError) {
  const result = response?.result;
  status.sentCount = Number(result?.sentCount || 0);
  status.matchedCount = Number(result?.matchedCount || 0);
  status.createdCount = Number(result?.createdCount || 0);
  status.unmatchedCount = Number(result?.unmatchedCount || 0);
  status.failedCount = Number(result?.failedCount || 0);
  status.previewCount = Number(result?.previewCount || 0);
  status.previewOnly = Boolean(result?.previewOnly);
  status.dryRun = Boolean(status.dryRun || result?.dryRun);
  status.items = mergeClassroomHubResults(status.items, result?.results);
  if (Array.isArray(result?.errors)) status.errors.push(...result.errors);
  if (!response?.ok && status.errors.length === 0) {
    status.error = response?.error || fallbackError;
    status.errors.push(status.error);
  }
  status.ok = Boolean(response?.ok) && status.errors.length === 0;
}

async function syncInCampusAssignments(options = {}) {
  const force = Boolean(options.force);
  const dryRun = await isSyncPreviewOnly(options);
  const limit = Object.prototype.hasOwnProperty.call(options, "limit")
    ? normalizeDetailFetchLimit(options.limit)
    : await getStoredSyncLimit();

  if (!isInCampusPage()) {
    return {
      ok: false,
      error: "inCampusのページではありません。"
    };
  }

  if (isSyncing) {
    return {
      ok: false,
      error: "すでに同期中です。"
    };
  }

  if (!force && !(await isAutoSyncEnabled())) {
    return {
      ok: true,
      skipped: true,
      reason: "自動同期がOFFのためスキップしました。"
    };
  }

  if (await shouldSkipAutoSync(force)) {
    return {
      ok: true,
      skipped: true,
      reason: "短時間の連続同期を避けるためスキップしました。"
    };
  }

  isSyncing = true;

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
    previewCount: 0,
    limit,
    dryRun,
    items: [],
    errors: []
  };

  try {
    const [updateInfoHtml, hubConnectionStatus] = await Promise.all([
      fetchInCampusHtml(toAbsoluteInCampusUrl(UPDATEINFO_PATH)),
      dryRun ? Promise.resolve({ ok: true }) : getHubConnectionStatus()
    ]);

    if (!dryRun && !hubConnectionStatus?.ok) {
      return {
        ok: false,
        skipped: !force,
        error: getHubConnectionError(hubConnectionStatus),
        reason: getHubConnectionError(hubConnectionStatus)
      };
    }

    const notifications = dedupeNotifications(parseReportNotifications(updateInfoHtml))
      .slice(0, limit);

    status.foundCount = notifications.length;

    for (const notification of notifications) {
      try {
        let assignment = null;

        if (notification.kind === "submissionRecord") {
          assignment = buildSubmissionRecordAssignment(notification);
        } else if (notification.kind === "announcement") {
          assignment = buildInCampusAnnouncement(notification);
        } else {
          const detailHtml = await fetchInCampusHtml(notification.detailUrl);
          assignment = extractAssignmentFromDetailHtml(
            detailHtml,
            notification.detailUrl,
            notification
          );
        }

        if (!assignment) {
          status.errors.push(`${notification.detailUrl}: 課題情報を抽出できませんでした。`);
          continue;
        }

        if (assignment.type === "submissionRecord") {
          status.submissionRecordCount++;
        } else if (assignment.type === "announcement") {
          status.announcementCount++;
        } else {
          status.assignmentCount++;
        }

        if (dryRun) {
          status.previewCount++;
          status.items.push({
            action: "preview",
            type: assignment.type || "assignment",
            title: assignment.title || "",
            courseName: assignment.courseName || "",
            pageUrl: assignment.pageUrl || "",
            assignmentKey: assignment.assignmentKey || ""
          });
          continue;
        }

        const result = await postAssignment(assignment);

        if (!result?.ok) {
          status.errors.push(`${assignment.title || assignment.pageUrl}: ${result?.error || "送信失敗"}`);
          continue;
        }

        if (result.result?.dryRun) {
          status.previewOnly = true;
          status.previewCount++;
          status.items.push({
            action: "preview", type: assignment.type || "assignment",
            title: assignment.title || "", courseName: assignment.courseName || "",
            pageUrl: assignment.pageUrl || "", assignmentKey: assignment.assignmentKey || ""
          });
          continue;
        }

        status.sentCount++;
        const updated = Boolean(result.result?.updated);

        if (updated) {
          status.updatedCount++;
        } else {
          status.newCount++;
        }

        status.items.push({
          action: updated ? "updated" : "created",
          type: assignment.type || "assignment",
          title: assignment.title || "",
          courseName: assignment.courseName || "",
          pageUrl: assignment.pageUrl || "",
          assignmentKey: assignment.assignmentKey || ""
        });
      } catch (error) {
        status.errors.push(String(error?.message || error));
      }
    }

    status.ok = status.errors.length === 0;
    status.finishedAt = new Date().toISOString();

    if (!dryRun && !status.previewOnly && status.ok) {
      await chrome.storage.local.set({
        lastInCampusAutoSyncAt: Date.now()
      });
    }
    await saveSyncStatus(status);

    return status;
  } catch (error) {
    status.ok = false;
    status.finishedAt = new Date().toISOString();
    status.errors.push(String(error?.message || error));
    await saveSyncStatus(status);
    return status;
  } finally {
    isSyncing = false;
  }
}

async function syncClassroomCompletionRecords(options = {}) {
  const dryRun = await isSyncPreviewOnly(options);
  const root = options.root || document;
  const pageUrl = options.pageUrl || location.href;
  const status = {
    ok: false,
    source: "Google Classroom",
    mode: "classroomCompletion",
    startedAt: new Date().toISOString(),
    foundCount: 0,
    completedCount: 0,
    matchedCount: 0,
    createdCount: 0,
    unmatchedCount: 0,
    sentCount: 0,
    previewCount: 0,
    dryRun,
    items: [],
    errors: []
  };

  try {
    const extraction = await collectClassroomRecordsFromDocument("completion", root, pageUrl);
    status.expandedSectionCount = extraction.expandedSectionCount;

    if (!extraction.ok) {
      status.error = extraction.error || "Classroom完了情報の抽出に失敗しました。";
      status.errors.push(status.error);
      status.finishedAt = new Date().toISOString();
      await saveSyncStatus(status);
      return status;
    }

    status.foundCount = extraction.records.length;
    status.completedCount = extraction.records.length;
    status.items = extraction.records.map((record) => ({
      action: dryRun ? "preview" : "completed",
      type: "classroomCompletion",
      title: record.title || "",
      courseName: record.courseName || "",
      pageUrl: record.classroomUrl || "",
      courseId: record.courseId || "",
      streamItemId: record.streamItemId || ""
    }));

    if (dryRun) {
      status.previewCount = extraction.records.length;
      status.ok = true;
      status.finishedAt = new Date().toISOString();
      await saveSyncStatus(status);
      return status;
    }

    const hubConnectionStatus = await getHubConnectionStatus();

    if (!hubConnectionStatus?.ok) {
      status.error = getHubConnectionError(hubConnectionStatus);
      status.errors.push(status.error);
      status.finishedAt = new Date().toISOString();
      await saveSyncStatus(status);
      return status;
    }

    const result = await postClassroomCompletionRecords(extraction.records);
    applyClassroomPostResult(status, result, "Classroom完了情報の送信に失敗しました。");
    status.finishedAt = new Date().toISOString();
    await saveSyncStatus(status);
    return status;
  } catch (error) {
    status.ok = false;
    status.finishedAt = new Date().toISOString();
    status.errors.push(String(error?.message || error));
    await saveSyncStatus(status);
    return status;
  }
}

async function syncClassroomDueTimeRecords(options = {}) {
  const dryRun = await isSyncPreviewOnly(options);
  const root = options.root || document;
  const pageUrl = options.pageUrl || location.href;
  const status = {
    ok: false,
    source: "Google Classroom",
    mode: "classroomDueTime",
    startedAt: new Date().toISOString(),
    foundCount: 0,
    dueTimeCount: 0,
    matchedCount: 0,
    createdCount: 0,
    unmatchedCount: 0,
    sentCount: 0,
    previewCount: 0,
    expandedSectionCount: 0,
    dryRun,
    items: [],
    errors: []
  };

  try {
    const extraction = await collectClassroomRecordsFromDocument("dueTime", root, pageUrl);
    status.expandedSectionCount = extraction.expandedSectionCount;

    if (!extraction.ok) {
      status.error = extraction.error || "Classroom期限情報の抽出に失敗しました。";
      status.errors.push(status.error);
      status.finishedAt = new Date().toISOString();
      await saveSyncStatus(status);
      return status;
    }

    status.foundCount = extraction.records.length;
    status.dueTimeCount = extraction.records.filter((record) => record.dueTime).length;
    status.items = extraction.records.map((record) => ({
      action: dryRun ? "preview" : "dueTime",
      type: "classroomDueTime",
      title: record.title || "",
      courseName: record.courseName || "",
      pageUrl: record.classroomUrl || "",
      dueText: record.dueText || "",
      dueTime: record.dueTime || "",
      courseId: record.courseId || "",
      streamItemId: record.streamItemId || ""
    }));

    if (dryRun) {
      status.previewCount = extraction.records.length;
      status.ok = true;
      status.finishedAt = new Date().toISOString();
      await saveSyncStatus(status);
      return status;
    }

    const hubConnectionStatus = await getHubConnectionStatus();

    if (!hubConnectionStatus?.ok) {
      status.error = getHubConnectionError(hubConnectionStatus);
      status.errors.push(status.error);
      status.finishedAt = new Date().toISOString();
      await saveSyncStatus(status);
      return status;
    }

    const result = await postClassroomDueTimeRecords(extraction.records);
    applyClassroomPostResult(status, result, "Classroom期限情報の送信に失敗しました。");
    status.finishedAt = new Date().toISOString();
    await saveSyncStatus(status);
    return status;
  } catch (error) {
    status.ok = false;
    status.finishedAt = new Date().toISOString();
    status.errors.push(String(error?.message || error));
    await saveSyncStatus(status);
    return status;
  }
}

function renderAutoSyncResult(result) {
  if (result?.skipped) {
    showInCampusSyncDebug(result.reason || "同期をスキップしました。");
    return;
  }

  if (!result?.ok) {
    const errorText = result?.errors?.[0] || result?.error || "同期に失敗しました。";
    showInCampusSyncDebug(errorText, true);
    return;
  }

  if (result.dryRun || result.previewOnly) {
    showInCampusSyncDebug(`プレビュー完了: 確認${result.previewCount || 0}件 / 送信${result.sentCount || 0}件`);
    return;
  }

  if (result.mode === "classroomCompletion") {
    showInCampusSyncDebug(
      `Classroom完了自動同期完了: 検出${result.foundCount || 0}件 / 更新${result.matchedCount || 0}件 / 未一致${result.unmatchedCount || 0}件`
    );
    return;
  }

  if (result.mode === "classroomDueTime") {
    showInCampusSyncDebug(
      `Classroom期限自動同期完了: 検出${result.foundCount || 0}件 / 時刻あり${result.dueTimeCount || 0}件 / 更新${result.matchedCount || 0}件`
    );
    return;
  }

  if (result.mode === "classroomHome") {
    showInCampusSyncDebug(
      `Classroomホーム自動同期完了: 検出${result.foundCount || 0}件 / 更新${result.matchedCount || 0}件 / 未一致${result.unmatchedCount || 0}件`
    );
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

async function runClassroomAutoSyncMode(mode, reason, options = {}) {
  const force = Boolean(options.force);
  const root = options.root;
  const pageUrl = options.pageUrl;
  const skip = await shouldSkipClassroomAutoSync(mode, force);

  if (skip) {
    showInCampusSyncDebug(`Classroom${getClassroomAutoSyncModeLabel(mode)}は直近で同期済みのためスキップしました。`);
    return null;
  }

  if (mode === "completion") {
    showInCampusSyncDebug(root ? "Classroom完了ページを裏で読み込んだため自動同期を開始します。" : "Classroom完了ページを検出したため自動同期を開始します。");
    const result = await syncClassroomCompletionRecords({ reason, root, pageUrl });

    if (result?.ok && !result.dryRun && !result.previewOnly) {
      await markClassroomAutoSyncCompleted(mode);
    }

    return result;
  }

  if (mode === "dueTime") {
    showInCampusSyncDebug(root ? "Classroom未提出ページを裏で読み込んだため期限自動同期を開始します。" : "Classroom未提出ページを検出したため期限自動同期を開始します。");
    const result = await syncClassroomDueTimeRecords({ reason, root, pageUrl });

    if (result?.ok && !result.dryRun && !result.previewOnly) {
      await markClassroomAutoSyncCompleted(mode);
    }

    return result;
  }

  return null;
}

async function runClassroomAutoSyncModeInHiddenFrame(mode, reason) {
  let framePage;

  try {
    framePage = await loadClassroomDocumentInHiddenFrame(mode);
    return await runClassroomAutoSyncMode(mode, reason, {
      force: true,
      root: framePage.doc,
      pageUrl: framePage.url
    });
  } catch (error) {
    const message = `${getClassroomAutoSyncModeLabel(mode)}: ${String(error?.message || error)}`;
    return { ok: false, mode, error: message, errors: [message], items: [] };
  } finally {
    framePage?.cleanup();
  }
}

function buildClassroomHomeAutoSyncStatus(results, startedAt) {
  const validResults = results.filter(Boolean);
  const errors = validResults.flatMap((result) => Array.isArray(result.errors) ? result.errors : []);
  const ok = validResults.length > 0 && validResults.every((result) => result.ok);

  return {
    ok,
    source: "Google Classroom",
    mode: "classroomHome",
    startedAt,
    finishedAt: new Date().toISOString(),
    foundCount: validResults.reduce((sum, result) => sum + Number(result.foundCount || 0), 0),
    completedCount: validResults.reduce((sum, result) => sum + Number(result.completedCount || 0), 0),
    dueTimeCount: validResults.reduce((sum, result) => sum + Number(result.dueTimeCount || 0), 0),
    matchedCount: validResults.reduce((sum, result) => sum + Number(result.matchedCount || 0), 0),
    createdCount: validResults.reduce((sum, result) => sum + Number(result.createdCount || 0), 0),
    unmatchedCount: validResults.reduce((sum, result) => sum + Number(result.unmatchedCount || 0), 0),
    sentCount: validResults.reduce((sum, result) => sum + Number(result.sentCount || 0), 0),
    previewCount: validResults.reduce((sum, result) => sum + Number(result.previewCount || 0), 0),
    dryRun: validResults.length > 0 && validResults.every((result) => result.dryRun),
    previewOnly: validResults.some((result) => result.previewOnly || result.dryRun),
    failedCount: validResults.reduce((sum, result) => sum + Number(result.failedCount || 0), 0),
    items: validResults.flatMap((result) => Array.isArray(result.items) ? result.items : []),
    errors
  };
}

async function startClassroomHomeAutoSyncSequence(reason) {
  if (await shouldSkipClassroomAutoSync("home", false)) {
    showInCampusSyncDebug("Classroomホーム自動同期は直近で実行済みのためスキップしました。");
    return null;
  }

  const dueTimeSkipped = await shouldSkipClassroomAutoSync("dueTime", false);
  const completionSkipped = await shouldSkipClassroomAutoSync("completion", false);
  const nextStep = !dueTimeSkipped ? "dueTime" : !completionSkipped ? "completion" : "";

  if (!nextStep) {
    await markClassroomAutoSyncCompleted("home");
    showInCampusSyncDebug("Classroom期限・完了は直近で同期済みのためスキップしました。");
    return null;
  }

  const startedAt = new Date().toISOString();
  const results = [];

  showInCampusSyncDebug("Classroomホームを検出したため裏で自動同期を開始します。");

  if (!dueTimeSkipped) {
    results.push(await runClassroomAutoSyncModeInHiddenFrame("dueTime", reason));
  }

  if (!completionSkipped) {
    results.push(await runClassroomAutoSyncModeInHiddenFrame("completion", reason));
  }

  const status = buildClassroomHomeAutoSyncStatus(results, startedAt);

  await saveSyncStatus(status);
  if (status.ok && !status.dryRun && !status.previewOnly) {
    await markClassroomAutoSyncCompleted("home");
  }

  return status;
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

    Promise.all([
      isAutoSyncEnabled(),
      shouldSkipAutoSync(false)
    ])
      .then(([enabled, skip]) => {
        if (!enabled) {
          return null;
        }

        if (skip) {
          showInCampusSyncDebug("直近で同期済みのためスキップしました。");
          return null;
        }

        showInCampusSyncDebug("ホームを検出したため自動同期を開始します。");
        return syncInCampusAssignments({ force: false, reason });
      })
      .then((result) => {
        if (result) {
          renderAutoSyncResult(result);
        }
      })
      .catch(saveFailedAutoSyncStatus);
  }, INCAMPUS_AUTO_SYNC_START_DELAY_MS);
}

function scheduleClassroomAutoSync(reason = "classroom") {
  const mode = getClassroomAutoSyncMode();

  if (!mode) {
    return;
  }

  window.clearTimeout(pendingClassroomAutoSyncTimerId);
  pendingClassroomAutoSyncTimerId = window.setTimeout(() => {
    pendingClassroomAutoSyncTimerId = 0;

    const currentMode = getClassroomAutoSyncMode();

    if (!currentMode) {
      return;
    }

    if (isClassroomAutoSyncing) {
      return;
    }

    isClassroomAutoSyncing = true;

    isClassroomAutoSyncEnabled()
      .then(async (enabled) => {
        if (!enabled) {
          return null;
        }

        if (currentMode === "home") {
          return startClassroomHomeAutoSyncSequence(reason);
        }

        return runClassroomAutoSyncMode(currentMode, reason);
      })
      .then((result) => {
        if (result) {
          renderAutoSyncResult(result);
        }
      })
      .catch(saveFailedAutoSyncStatus)
      .finally(() => {
        isClassroomAutoSyncing = false;
      });
  }, CLASSROOM_AUTO_SYNC_START_DELAY_MS);
}

function checkNavigation(reason = "url-watch", allowSameUrl = false) {
  const currentUrl = location.href;

  if (!allowSameUrl && currentUrl === lastObservedUrl) {
    return;
  }

  lastObservedUrl = currentUrl;
  scheduleHomeAutoSync(reason);
  scheduleClassroomAutoSync(reason);
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
  scheduleClassroomAutoSync("initial");

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
      isClassroomPage: isClassroomPage(),
      isClassroomHomePage: isClassroomHomePage(),
      isClassroomTurnedInPage: isClassroomTurnedInPage(),
      isClassroomNotTurnedInPage: isClassroomNotTurnedInPage(),
      url: location.href
    });
    return false;
  }

  if (message?.type === "RUN_CLASSROOM_COMPLETION_SYNC") {
    syncClassroomCompletionRecords({
      dryRun: Boolean(message.dryRun)
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "RUN_CLASSROOM_DUE_TIME_SYNC") {
    syncClassroomDueTimeRecords({
      dryRun: Boolean(message.dryRun)
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "DEBUG_EXTRACT_CLASSROOM_PAYLOAD") {
    extractClassroomDebugPayload()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        source: "Google Classroom",
        debug: true,
        error: String(error?.message || error),
        pageUrl: location.href,
        payloads: []
      }));

    return true;
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
          action: "upsertInCampusAssignment",
          requests: []
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
