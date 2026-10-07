const HUB_POST_TIMEOUT_MS = 30000;
const HUB_DIAGNOSE_TIMEOUT_MS = 12000;
const HUB_MAX_POST_BODY_LENGTH = 190000;
const HUB_MAX_POST_RECORDS = 100;
const HUB_API_TOKEN_MIN_LENGTH = 48;
const ALLOWED_HUB_WEB_APP_HOSTS = new Set([
  "script.google.com",
  "script.googleusercontent.com"
]);

async function getStoredWebAppUrl() {
  const { webAppUrl } = await chrome.storage.local.get("webAppUrl");
  return String(webAppUrl || "").trim();
}

async function getStoredApiToken() {
  const { apiToken } = await chrome.storage.local.get("apiToken");
  return String(apiToken || "").trim();
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

async function getHubConnectionSettings() {
  return {
    webAppUrl: normalizeHubWebAppUrl(await getStoredWebAppUrl()),
    apiToken: normalizeHubApiToken(await getStoredApiToken())
  };
}

async function getHubConnectionStatus() {
  try {
    const { webAppUrl, apiToken } = await getHubConnectionSettings();

    return {
      ok: Boolean(webAppUrl && apiToken),
      hasWebAppUrl: Boolean(webAppUrl),
      hasApiToken: Boolean(apiToken),
      error: !webAppUrl
        ? "GAS WebアプリURLが未設定です。"
        : !apiToken
          ? "APIトークンが未設定です。"
          : ""
    };
  } catch (error) {
    return {
      ok: false,
      hasWebAppUrl: false,
      hasApiToken: false,
      error: String(error?.message || error)
    };
  }
}

function buildAuthenticatedPayload(payload, apiToken) {
  if (!apiToken) {
    throw new Error("APIトークンが未設定です。Hubのセキュリティ設定からコピーして拡張機能に貼り付けてください。");
  }

  return {
    ...payload,
    apiToken
  };
}

function summarizeResponseText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function saveSyncStatus(status) {
  const safeStatus = status && typeof status === "object" && !Array.isArray(status)
    ? status
    : {
      ok: false,
      errors: ["同期状態の保存に失敗しました。"]
    };

  await chrome.storage.local.set({
    lastInCampusSyncStatus: {
      ...safeStatus,
      savedAt: new Date().toISOString()
    }
  });
}

async function parseHubResponse(response) {
  const text = await response.text();
  let result;

  try {
    result = JSON.parse(text);
  } catch (_) {
    const summary = summarizeResponseText(text);
    const detail = summary ? ` レスポンス: ${summary}` : "";

    throw new Error(
      response.ok
        ? `GASからJSONではないレスポンスが返りました。WebアプリURLと公開設定を確認してください。${detail}`
        : `送信に失敗しました。status=${response.status}${detail}`
    );
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("GASから不正なJSONレスポンスが返りました。");
  }

  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `送信に失敗しました。status=${response.status}`);
  }

  return result;
}

async function postJsonToHub(webAppUrl, payload) {
  // Check immediately before every request, including later batches and manual posts.
  const { previewOnly } = await chrome.storage.local.get("previewOnly");
  if (previewOnly) {
    return { ok: true, dryRun: true, skipped: true, previewOnly: true };
  }

  const body = JSON.stringify(payload);

  if (body.length > HUB_MAX_POST_BODY_LENGTH) {
    throw new Error("送信データが大きすぎます。同期対象件数を減らしてください。");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HUB_POST_TIMEOUT_MS);

  try {
    const response = await fetch(webAppUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body,
      signal: controller.signal
    });

    return await parseHubResponse(response);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("GASへの送信がタイムアウトしました。");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postAssignmentToHub(assignment) {
  const { previewOnly } = await chrome.storage.local.get("previewOnly");
  if (previewOnly) {
    return { ok: true, dryRun: true, skipped: true, previewOnly: true };
  }
  const { webAppUrl, apiToken } = await getHubConnectionSettings();

  if (!webAppUrl) {
    return {
      ok: false,
      missingWebAppUrl: true,
      error: "GAS WebアプリURLが未設定です。"
    };
  }

  return postJsonToHub(webAppUrl, buildAuthenticatedPayload({
    action: "upsertInCampusAssignment",
    assignment
  }, apiToken));
}

function buildClassroomRecordOutcome(record, index, extra) {
  return {
    title: record?.title || "",
    courseName: record?.courseName || "",
    classroomUrl: record?.classroomUrl || record?.pageUrl || "",
    courseId: record?.courseId || "",
    streamItemId: record?.streamItemId || "",
    recordIndex: index,
    ...extra
  };
}

async function postClassroomRecordsToHub(action, records) {
  if (!Array.isArray(records)) {
    throw new Error("recordsが配列ではありません。");
  }
  const aggregate = {
    ok: true, foundCount: records.length, sentCount: 0, matchedCount: 0,
    createdCount: 0, unmatchedCount: 0, failedCount: 0, previewCount: 0,
    batchCount: 0, results: [], errors: []
  };
  const { previewOnly } = await chrome.storage.local.get("previewOnly");
  if (previewOnly) {
    return {
      ...aggregate, dryRun: true, previewOnly: true, previewCount: records.length,
      results: records.map((record, index) => buildClassroomRecordOutcome(record, index, { preview: true }))
    };
  }
  const { webAppUrl, apiToken } = await getHubConnectionSettings();

  if (!webAppUrl) {
    return {
      ok: false,
      missingWebAppUrl: true,
      error: "GAS WebアプリURLが未設定です。"
    };
  }

  const batches = [];
  let batch = [];
  const payloadFor = (entries) => buildAuthenticatedPayload({
    action, records: entries.map((entry) => entry.record)
  }, apiToken);
  const failEntries = (entries, error) => {
    const reason = String(error?.message || error);
    aggregate.errors.push(reason);
    aggregate.failedCount += entries.length;
    entries.forEach(({ record, index }) => aggregate.results.push(
      buildClassroomRecordOutcome(record, index, { failed: true, matched: false, reason })
    ));
  };

  records.forEach((record, index) => {
    const entry = { record, index };
    if (JSON.stringify(payloadFor([entry])).length > HUB_MAX_POST_BODY_LENGTH) {
      failEntries([entry], `${record?.title || `課題${index + 1}`}: 1件の送信データが大きすぎます。`);
      return;
    }
    if (batch.length >= HUB_MAX_POST_RECORDS ||
        JSON.stringify(payloadFor(batch.concat(entry))).length > HUB_MAX_POST_BODY_LENGTH) {
      batches.push(batch);
      batch = [];
    }
    batch.push(entry);
  });
  if (batch.length) batches.push(batch);

  for (const entries of batches) {
    try {
      const result = await postJsonToHub(webAppUrl, payloadFor(entries));
      if (result.dryRun) {
        aggregate.previewOnly = true;
        aggregate.previewCount += entries.length;
        entries.forEach(({ record, index }) => aggregate.results.push(
          buildClassroomRecordOutcome(record, index, { preview: true })
        ));
        continue;
      }
      if (!Array.isArray(result.results) || result.results.length !== entries.length ||
          result.results.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error("Classroom同期結果の件数が送信件数と一致しません。反映状態を確認してください。");
      }
      aggregate.batchCount++;
      aggregate.sentCount += entries.length;
      result.results.forEach((item, resultIndex) => {
        const { record, index } = entries[resultIndex];
        aggregate.results.push(buildClassroomRecordOutcome(record, index, { ...item, recordIndex: index }));
        if (item.failed) {
          aggregate.failedCount++;
          aggregate.errors.push(item.reason || "課題の同期に失敗しました。");
        } else if (item.matched) {
          aggregate.matchedCount++;
        } else {
          aggregate.unmatchedCount++;
        }
        if (item.created) aggregate.createdCount++;
      });
    } catch (error) {
      failEntries(entries, error);
    }
  }
  aggregate.results.sort((left, right) => left.recordIndex - right.recordIndex);
  aggregate.ok = aggregate.errors.length === 0;
  aggregate.dryRun = Boolean(aggregate.previewOnly && aggregate.sentCount === 0);
  return aggregate;
}

async function postClassroomCompletionRecordsToHub(records) {
  return postClassroomRecordsToHub("completeClassroomAssignments", records);
}

async function postClassroomDueTimeRecordsToHub(records) {
  return postClassroomRecordsToHub("updateClassroomDueTimes", records);
}

async function diagnoseHubWebAppUrl(webAppUrl) {
  const normalizedUrl = normalizeHubWebAppUrl(webAppUrl);

  if (!normalizedUrl) {
    return {
      ok: false,
      error: "GAS WebアプリURLが未設定です。"
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HUB_DIAGNOSE_TIMEOUT_MS);

  try {
    const response = await fetch(normalizedUrl, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const summary = summarizeResponseText(text);
    const looksLikeLogin = /ログイン|sign in|accounts\.google\.com|authorization required|承認/i.test(summary);

    if (!response.ok) {
      return {
        ok: false,
        error: `GET確認に失敗しました。status=${response.status}${summary ? ` ${summary}` : ""}`
      };
    }

    if (looksLikeLogin) {
      return {
        ok: false,
        error: "URLには到達しましたが、ログインまたは公開設定の確認が必要そうです。Webアプリのアクセス権を確認してください。"
      };
    }

    return {
      ok: true,
      message: `URLへ到達できました。status=${response.status}${contentType ? ` / ${contentType.split(";")[0]}` : ""}`
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        error: "GAS URL確認がタイムアウトしました。"
      };
    }

    return {
      ok: false,
      error: String(error?.message || error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "POST_INCAMPUS_ASSIGNMENT") {
    postAssignmentToHub(message.assignment)
      .then((result) => sendResponse({ ok: result.ok !== false, result, error: result.error || "" }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "POST_CLASSROOM_COMPLETION_RECORDS") {
    postClassroomCompletionRecordsToHub(message.records || [])
      .then((result) => sendResponse({ ok: result.ok !== false, result, error: result.error || "" }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "POST_CLASSROOM_DUE_TIME_RECORDS") {
    postClassroomDueTimeRecordsToHub(message.records || [])
      .then((result) => sendResponse({ ok: result.ok !== false, result, error: result.error || "" }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "DIAGNOSE_HUB_WEB_APP_URL") {
    diagnoseHubWebAppUrl(message.webAppUrl)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "GET_HUB_CONNECTION_STATUS") {
    getHubConnectionStatus()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "SAVE_INCAMPUS_SYNC_STATUS") {
    saveSyncStatus(message.status || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  return false;
});
