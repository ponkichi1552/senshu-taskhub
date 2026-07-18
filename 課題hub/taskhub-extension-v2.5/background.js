const HUB_POST_TIMEOUT_MS = 30000;
const HUB_DIAGNOSE_TIMEOUT_MS = 12000;
const HUB_MAX_POST_BODY_LENGTH = 190000;
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HUB_POST_TIMEOUT_MS);
  const body = JSON.stringify(payload);

  if (body.length > HUB_MAX_POST_BODY_LENGTH) {
    throw new Error("送信データが大きすぎます。同期対象件数を減らしてください。");
  }

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

async function postClassroomCompletionRecordsToHub(records) {
  const { webAppUrl, apiToken } = await getHubConnectionSettings();

  if (!webAppUrl) {
    return {
      ok: false,
      missingWebAppUrl: true,
      error: "GAS WebアプリURLが未設定です。"
    };
  }

  return postJsonToHub(webAppUrl, buildAuthenticatedPayload({
    action: "completeClassroomAssignments",
    records
  }, apiToken));
}

async function postClassroomDueTimeRecordsToHub(records) {
  const { webAppUrl, apiToken } = await getHubConnectionSettings();

  if (!webAppUrl) {
    return {
      ok: false,
      missingWebAppUrl: true,
      error: "GAS WebアプリURLが未設定です。"
    };
  }

  return postJsonToHub(webAppUrl, buildAuthenticatedPayload({
    action: "updateClassroomDueTimes",
    records
  }, apiToken));
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
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "POST_CLASSROOM_COMPLETION_RECORDS") {
    postClassroomCompletionRecordsToHub(message.records || [])
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "POST_CLASSROOM_DUE_TIME_RECORDS") {
    postClassroomDueTimeRecordsToHub(message.records || [])
      .then((result) => sendResponse({ ok: true, result }))
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
