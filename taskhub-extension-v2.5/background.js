const HUB_POST_TIMEOUT_MS = 30000;
const HUB_DIAGNOSE_TIMEOUT_MS = 12000;
const HUB_MAX_POST_BODY_LENGTH = 190000;
const HUB_MAX_POST_RECORDS = 100;
const HUB_API_TOKEN_MIN_LENGTH = 48;
const INCAMPUS_SYNC_LEASE_MS = 5 * 60 * 1000;
const INCAMPUS_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const INCAMPUS_RETRY_INTERVAL_MS = 60 * 1000;
let inCampusLeaseQueue = Promise.resolve();

function withInCampusLeaseLock(operation) {
  const result = inCampusLeaseQueue.then(operation);
  inCampusLeaseQueue = result.catch(() => {});
  return result;
}

function acquireInCampusSync(message) {
  return withInCampusLeaseLock(async () => {
    const settings = await chrome.storage.local.get(['inCampusSyncLease', 'lastInCampusAutoSyncAt', 'lastInCampusSyncAttemptAt', 'lastInCampusPreviewSyncAt']);
    const now = Date.now();
    if (Number(settings.inCampusSyncLease?.expiresAt || 0) > now) {
      return {ok: true, skipped: true, reason: '別のinCampusタブですでに同期中のためスキップしました。'};
    }
    const succeededAt = Number(message.dryRun ? settings.lastInCampusPreviewSyncAt : settings.lastInCampusAutoSyncAt) || 0;
    if (!message.force && succeededAt > 0 && now - succeededAt < INCAMPUS_AUTO_SYNC_INTERVAL_MS) {
      return {ok: true, skipped: true, reason: '短時間の連続同期を避けるためスキップしました。'};
    }
    const attemptedAt = Number(settings.lastInCampusSyncAttemptAt || 0);
    if (!message.force && attemptedAt > 0 && now - attemptedAt < INCAMPUS_RETRY_INTERVAL_MS) {
      return {ok: true, skipped: true, reason: '直前の読み取りから1分以内のためスキップしました。'};
    }
    const token = `${now}:${Math.random().toString(36).slice(2)}`;
    await chrome.storage.local.set({inCampusSyncLease: {token, expiresAt: now + INCAMPUS_SYNC_LEASE_MS}});
    return {ok: true, token};
  });
}

function releaseInCampusSync(token) {
  return withInCampusLeaseLock(async () => {
    const {inCampusSyncLease} = await chrome.storage.local.get('inCampusSyncLease');
    if (inCampusSyncLease?.token === token) await chrome.storage.local.set({inCampusSyncLease: null});
    return {ok: true};
  });
}
const ALLOWED_HUB_WEB_APP_HOSTS = new Set([
  "script.google.com",
  "script.googleusercontent.com"
]);

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
  const { webAppUrl, apiToken, previewOnly } = await chrome.storage.local.get(["webAppUrl", "apiToken", "previewOnly"]);
  return {
    webAppUrl: String(webAppUrl || "").trim(),
    apiToken: String(apiToken || "").trim(),
    previewOnly: Boolean(previewOnly)
  };
}

async function getHubConnectionStatus() {
  try {
    const settings = await getHubConnectionSettings();
    const webAppUrl = normalizeHubWebAppUrl(settings.webAppUrl);
    const apiToken = normalizeHubApiToken(settings.apiToken);

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

  if (!response.ok || result.ok !== true) {
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
  const settings = await getHubConnectionSettings();
  if (settings.previewOnly) {
    return { ok: true, dryRun: true, skipped: true, previewOnly: true };
  }

  if (!settings.webAppUrl) {
    return {
      ok: false,
      missingWebAppUrl: true,
      error: "GAS WebアプリURLが未設定です。"
    };
  }

  const webAppUrl = normalizeHubWebAppUrl(settings.webAppUrl);
  const apiToken = normalizeHubApiToken(settings.apiToken);
  const result = await postJsonToHub(webAppUrl, buildAuthenticatedPayload({
    action: "upsertInCampusAssignment",
    assignment
  }, apiToken));
  if (!result.dryRun && (!Number.isInteger(Number(result.row)) || Number(result.row) < 2 || typeof result.updated !== 'boolean')) {
    throw new Error('GASの保存結果に有効な保存行がありません。');
  }
  return result;
}

function buildInCampusAssignmentBatches(assignments, apiToken) {
  if (!Array.isArray(assignments)) throw new Error("送信する課題データの形式が正しくありません。");
  if (assignments.length > HUB_MAX_POST_RECORDS) throw new Error("一度に送信できる課題データが多すぎます。");

  const batches = [];
  let current = [];
  const getBodyLength = records => JSON.stringify(buildAuthenticatedPayload({
    action: "upsertInCampusAssignments",
    assignments: records
  }, apiToken)).length;

  for (const assignment of assignments) {
    const candidate = [...current, assignment];
    if (getBodyLength(candidate) <= HUB_MAX_POST_BODY_LENGTH) {
      current = candidate;
      continue;
    }

    if (current.length === 0) throw new Error("課題データ1件が送信上限を超えています。");
    batches.push(current);
    current = [assignment];
    if (getBodyLength(current) > HUB_MAX_POST_BODY_LENGTH) throw new Error("課題データ1件が送信上限を超えています。");
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function postAssignmentsToHub(assignments) {
  if (!Array.isArray(assignments)) return {ok: false, error: "送信する課題データの形式が正しくありません。"};
  if (assignments.length === 0) return {ok: true, result: {results: []}};

  try {
    const settings = await getHubConnectionSettings();
    if (settings.previewOnly) {
      return {
        ok: true,
        result: {
          dryRun: true,
          skipped: true,
          previewOnly: true,
          results: assignments.map(() => ({dryRun: true, skipped: true}))
        }
      };
    }
    const webAppUrl = normalizeHubWebAppUrl(settings.webAppUrl);
    const apiToken = normalizeHubApiToken(settings.apiToken);
    if (!webAppUrl) return {ok: false, error: "GAS WebアプリURLが未設定です。"};
    if (!apiToken) return {ok: false, error: "APIトークンが未設定です。"};

    const batches = buildInCampusAssignmentBatches(assignments, apiToken);
    const results = [];
    const errors = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      try {
        const response = await postJsonToHub(webAppUrl, buildAuthenticatedPayload({
          action: "upsertInCampusAssignments",
          assignments: batch
        }, apiToken));

        if (response?.dryRun || response?.previewOnly) {
          const remaining = assignments.length - results.length;
          for (let index = 0; index < remaining; index++) {
            results.push({dryRun: true, skipped: true});
          }
          errors.push("プレビュー設定がONになったため、残りの課題データは送信しませんでした。");
          break;
        }

        if (!Array.isArray(response?.results) || response.results.length !== batch.length) {
          throw new Error("GASから課題ごとの同期結果が返りませんでした。");
        }

        response.results.forEach(item => {
          const row = Number(item?.row || 0);
          if (item?.ok === false || !Number.isInteger(row) || row < 2 || typeof item?.updated !== 'boolean') {
            const error = item?.error || 'GASの保存結果に有効な保存行がありません。';
            results.push({ok: false, error});
            errors.push(error);
          } else {
            results.push({updated: item.updated, unchanged: Boolean(item.unchanged), row});
          }
        });
      } catch (error) {
        const message = String(error?.message || error);

        // Older deployed Hub scripts may still expose only the single-row
        // endpoint. The failed batch action is rejected before any rows are
        // written, so retry this batch through the compatible legacy action.
        if (/未対応のactionです:\s*upsertInCampusAssignments/.test(message)) {
          let stoppedByPreview = false;
          for (const assignment of batch) {
            try {
              const item = await postAssignmentToHub(assignment);
              if (item?.dryRun || item?.previewOnly) {
                results.push({dryRun: true, skipped: true});
                const remaining = assignments.length - results.length;
                for (let index = 0; index < remaining; index++) {
                  results.push({dryRun: true, skipped: true});
                }
                errors.push("プレビュー設定がONになったため、残りの課題データは送信しませんでした。");
                stoppedByPreview = true;
                break;
              }
              if (item?.ok === false || !Number.isInteger(Number(item?.row)) || Number(item.row) < 2 || typeof item?.updated !== 'boolean') {
                throw new Error(item.error || 'GASの保存結果に有効な保存行がありません。');
              }
              results.push({
                updated: Boolean(item?.updated),
                unchanged: Boolean(item?.unchanged),
                row: Number(item?.row || 0)
              });
            } catch (fallbackError) {
              const fallbackMessage = String(fallbackError?.message || fallbackError);
              results.push({ok: false, error: fallbackMessage});
              errors.push(fallbackMessage);
            }
          }
          if (stoppedByPreview) break;
          continue;
        }

        batch.forEach(() => results.push({ok: false, error: message}));
        errors.push(message);
      }
    }

    return {
      ok: errors.length === 0,
      result: {results},
      error: errors.join(" / ")
    };
  } catch (error) {
    return {ok: false, error: String(error?.message || error)};
  }
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
  if (message?.type === 'ACQUIRE_INCAMPUS_SYNC' || message?.type === 'RELEASE_INCAMPUS_SYNC') {
    const work = message.type === 'ACQUIRE_INCAMPUS_SYNC' ? acquireInCampusSync(message) : releaseInCampusSync(message.token);
    work.then(sendResponse).catch(error => sendResponse({ok: false, error: String(error?.message || error)}));
    return true;
  }
  if (message?.type === "POST_INCAMPUS_ASSIGNMENT") {
    postAssignmentToHub(message.assignment)
      .then((result) => sendResponse({ ok: result.ok !== false, result, error: result.error || "" }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error)
      }));

    return true;
  }

  if (message?.type === "POST_INCAMPUS_ASSIGNMENTS") {
    postAssignmentsToHub(message.assignments)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ok: false, error: String(error?.message || error)}));

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
