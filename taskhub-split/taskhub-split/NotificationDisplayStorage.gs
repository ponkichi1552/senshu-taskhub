// Materialized display tables keep raw notification records as the source of
// truth while moving parsing, classification, mapping, and supplement matching
// into sync-time work.
const NOTIFICATION_DISPLAY_DATA_REVISION = '2026-10-07-v5';
const NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY = 'TASKHUB_NOTIFICATION_DISPLAY_DATA_REVISION';
const NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY = 'TASKHUB_NOTIFICATION_DISPLAY_DATA_BUILDING';
const NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY = 'TASKHUB_NOTIFICATION_DISPLAY_DATA_GENERATION';
const NOTIFICATION_DISPLAY_SCHEMA_CACHE_PROPERTY = 'TASKHUB_NOTIFICATION_DISPLAY_SCHEMA_CACHE';
const NOTIFICATION_DISPLAY_SCHEMA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const UNIVERSITY_NOTICE_STATE_GENERATION_PROPERTY = 'TASKHUB_UNIVERSITY_NOTICE_STATE_GENERATION';
const UNIVERSITY_NOTICE_CACHE_PREFIX = 'taskhub-university-notices-v5';
// This generation-scoped cache stores full bodies for repeated searches only.
// Ordinary list and selected-body reads stay on compact prepared-sheet ranges.
const UNIVERSITY_NOTICE_CACHE_TTL_SECONDS = 21600;
const UNIVERSITY_NOTICE_CACHE_MAX_VALUE_LENGTH = 95000;
const TASK_DISPLAY_SHEET_NAME = '課題表示データ';
const COMPLETED_TASK_DISPLAY_SHEET_NAME = '完了課題表示データ';
const UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME = '大学通知表示データ';
const TASK_DISPLAY_STATUS_GENERATION_PROPERTY = 'TASKHUB_TASK_DISPLAY_STATUS_GENERATION';
const TASK_DISPLAY_CACHE_PREFIX = 'taskhub-task-display-v4';
// Display generations change on every rebuild, so a longer cache lifetime does
// not make stale rows visible. It keeps the prepared view hot between syncs.
const TASK_DISPLAY_CACHE_TTL_SECONDS = 21600;
const TASK_DISPLAY_CACHE_MAX_VALUE_LENGTH = 95000;

const TASK_DUE_DISPLAY_GROUPS = [
  {key: 'expired', label: '期限切れ', index: 0},
  {key: 'today', label: '今日まで', index: 1},
  {key: 'tomorrow', label: '明日まで', index: 2},
  {key: 'thisWeek', label: '今週中', index: 3},
  {key: 'later', label: '来週以降', index: 4},
  {key: 'none', label: '期限なし', index: 5},
  {key: 'unknown', label: '期限未検出', index: 6}
];

const LEGACY_TASK_DISPLAY_HEADERS = [
  '保存日時', 'メッセージID', '情報源', '授業名', 'タイトル', '曜日・時限',
  '期限表示', '期限日キー', '期限時刻', '期限種別', '期限判定元', '件名', '送信者',
  '受信日時', '受信日時UNIX', '表示用受信日時UNIX', 'Gmail受信日時',
  'Gmail受信日時UNIX', 'Gmailリンク', 'GmailメッセージID', 'Gmail本文',
  '関連Gmail ID一覧', 'Classroom URL', '表示本文', '状態', '完了日時',
  '完了日時UNIX', '期限判定用UNIX', '期限なし保持判定用UNIX'
];

const PREVIOUS_TASK_DISPLAY_HEADERS = LEGACY_TASK_DISPLAY_HEADERS.concat(
  '期限表示グループ', '期限表示グループ順'
);

const TASK_DISPLAY_FIELDS = [
  'savedAt', 'messageId', 'source', 'courseName', 'title', 'weekdayPeriod',
  'dueDate', 'dueDateKey', 'dueTime', 'dueType', 'dueStatus', 'subject', 'from',
  'receivedAt', 'receivedAtTime', 'displayReceivedAtTime', 'gmailReceivedAt',
  'gmailReceivedAtTime', 'gmailLink', 'gmailMessageId', 'gmailBody',
  'gmailMessageIds', 'classroomUrl', 'body', 'status', 'completedAt',
  'completedAtTime', 'deadlineAtTime', 'staleAtTime', 'displayDueGroupKey',
  'displayDueGroupIndex', 'displayDueGroupCount', 'displayDueGroupCourseCountsJson'
];

const TASK_DISPLAY_HEADERS = [
  '保存日時', 'メッセージID', '情報源', '授業名', 'タイトル', '曜日・時限',
  '期限表示', '期限日キー', '期限時刻', '期限種別', '期限判定元', '件名', '送信者',
  '受信日時', '受信日時UNIX', '表示用受信日時UNIX', 'Gmail受信日時',
  'Gmail受信日時UNIX', 'Gmailリンク', 'GmailメッセージID', 'Gmail本文',
  '関連Gmail ID一覧', 'Classroom URL', '表示本文', '状態', '完了日時',
  '完了日時UNIX', '期限判定用UNIX', '期限なし保持判定用UNIX',
  '期限表示グループ', '期限表示グループ順', '期限表示グループ件数',
  '期限グループ授業別件数JSON'
];

const UNIVERSITY_NOTICE_DISPLAY_FIELDS = [
  'messageId', 'source', 'title', 'courseName', 'from', 'receivedAt',
  'receivedAtTime', 'gmailLink', 'preview', 'expiresAtTime',
  'originalMessageIdForState', 'supplementKey', 'supplementUpdatedAt', 'body'
];

const UNIVERSITY_NOTICE_DISPLAY_HEADERS = [
  'メッセージID', '情報源', 'タイトル', '授業名', '送信者', '受信日時',
  '受信日時UNIX', 'Gmailリンク', '本文抜粋', '表示期限UNIX',
  '既読状態照合用元ID', 'inCampus補足キー', 'inCampus補足更新日時', '表示本文'
];

const PREVIOUS_UNIVERSITY_NOTICE_DISPLAY_HEADERS = [
  'メッセージID', '情報源', 'タイトル', '授業名', '送信者', '受信日時',
  '受信日時UNIX', 'Gmailリンク', '表示本文', '表示期限UNIX',
  '既読状態照合用元ID', 'inCampus補足キー', 'inCampus補足更新日時'
];

// Apps Script RPC cannot reliably marshal Date instances or non-finite numbers
// nested in values read from Sheets. Return only JSON-safe values to the browser.
function toNotificationWebSafeValue_(value) {
  if (value instanceof Date) return formatDateForWeb_(value);
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toNotificationWebSafeValue_);
  if (typeof value === 'object') {
    const safeObject = {};
    Object.keys(value).forEach(key => {
      const safeValue = toNotificationWebSafeValue_(value[key]);
      if (safeValue !== undefined) safeObject[key] = safeValue;
    });
    return safeObject;
  }
  return String(value);
}

function normalizeNotificationDisplayDateKey_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:$|[ T])/);
  return match
    ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
    : text;
}

function normalizeNotificationDisplayTime_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}` : text;
}

function isNotificationDisplayDataCurrent_(userProperties) {
  const properties = userProperties || PropertiesService.getUserProperties().getProperties();
  return properties[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] === NOTIFICATION_DISPLAY_DATA_REVISION &&
    !hasNotificationDisplayDataWriteMarker_(properties);
}

function hasNotificationDisplayDataWriteMarker_(userProperties) {
  const properties = userProperties || PropertiesService.getUserProperties().getProperties();
  return Boolean(String(properties[NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY] || '').trim());
}

function isNotificationDisplayDataBuilding_(userProperties) {
  const properties = userProperties || PropertiesService.getUserProperties().getProperties();
  const startedAt = Number(properties[NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY] || 0);
  return Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < 5 * 60 * 1000;
}

function getNotificationDisplaySchemaCacheKey_(spreadsheet) {
  const spreadsheetId = spreadsheet && spreadsheet.getId ? spreadsheet.getId() : 'current-user';
  return [spreadsheetId, NOTIFICATION_DISPLAY_DATA_REVISION,
    TASK_DISPLAY_HEADERS.join('\u001f'), UNIVERSITY_NOTICE_DISPLAY_HEADERS.join('\u001f')].join('|');
}

function shouldValidateNotificationDisplaySheets_(spreadsheet, userProperties) {
  const props = userProperties || PropertiesService.getUserProperties();
  const saved = String(props.getProperty(NOTIFICATION_DISPLAY_SCHEMA_CACHE_PROPERTY) || '');
  const separator = saved.indexOf('|');
  if (separator < 1) return true;
  const checkedAt = Number(saved.slice(0, separator));
  const schemaKey = saved.slice(separator + 1);
  return schemaKey !== getNotificationDisplaySchemaCacheKey_(spreadsheet) ||
    !Number.isFinite(checkedAt) || checkedAt <= 0 || Date.now() - checkedAt >= NOTIFICATION_DISPLAY_SCHEMA_CACHE_TTL_MS;
}

function invalidateNotificationDisplaySchemaCache_() {
  PropertiesService.getUserProperties().deleteProperty(NOTIFICATION_DISPLAY_SCHEMA_CACHE_PROPERTY);
}

/** Rebuild both prepared views from the user's saved source data. Caller holds the user lock. */
function rebuildNotificationDisplayDataLocked_(spreadsheet, rebuildOptions) {
  const startedAt = Date.now();
  const options = rebuildOptions || {};
  let phaseStartedAt = startedAt;
  const phaseMs = Object.create(null);
  const recordPhase = name => {
    const now = Date.now();
    phaseMs[name] = now - phaseStartedAt;
    phaseStartedAt = now;
  };
  const referenceNow = new Date();
  const ss = spreadsheet || getOrCreateSpreadsheetLocked_();
  const props = PropertiesService.getUserProperties();
  const validateDisplaySheetSchemas = shouldValidateNotificationDisplaySheets_(ss, props);
  // Keep an interrupted writer's marker until this rebuild commits. That older
  // execution may have stopped partway through replacing the prepared sheets.
  // Normal rebuilds have no marker here, so their last complete generation
  // remains readable during the source scan and projection below.

  const sheetsBySource = options.sheetsBySource || ensureNotificationStorageLocked_(ss, options);
  recordPhase('ensureStorageMs');
  const readContext = {
    testMode: false,
    spreadsheet: ss,
    sheetsBySource,
    preloadedRowsBySource: options.preloadedRowsBySource || Object.create(null),
    sourceRowsBySource: Object.create(null),
    sheetReadMs: Object.create(null),
    sheetRowCounts: Object.create(null)
  };
  const rows = getNotificationRowsFromSheets_(
    sheetsBySource,
    false,
    null,
    readContext,
    {includeClassroomApi: true, mergeClassroomApiAssignments: true}
  );
  const extractedItems = getInCampusSupplementItemsForWeb_(null, null, null, readContext, true);
  recordPhase('sourceReadMs');

  const taskItems = rows
    .filter(row => isTaskRelatedRow_(row))
    .map(row => addStoredTaskDateChecks_(rowToNotificationItem_(row)));
  const mergedTasks = mergeNotificationAndInCampusExtractedItemsForWeb_(
    taskItems,
    extractedItems,
    'assignment',
    false
  );
  const activeTasks = prepareTaskDisplayItemsForSync_(mergedTasks, '未完了', referenceNow);
  const completedTasks = prepareTaskDisplayItemsForSync_(mergedTasks, '完了', referenceNow);

  const noticeItems = rows
    .filter(row => isUniversityNoticeRow_(row))
    .map(row => {
      const item = rowToUniversityNotice_(row);
      item.expiresAtTime = getUniversityNoticeExpiryTimeForDisplay_(row);
      item.originalMessageIdForState = String(row.originalMessageIdForState || '');
      return item;
    });
  const mergedNotices = filterUniversityNoticeDisplayItemsForNow_(
    buildUniversityNoticeDisplayItems_(noticeItems, extractedItems, false),
    referenceNow
  );
  recordPhase('classifyMergeFilterSortMs');

  const taskRows = activeTasks.map(taskDisplayItemToRow_);
  const completedTaskRows = completedTasks.map(taskDisplayItemToRow_);
  const noticeRows = mergedNotices.map(item => UNIVERSITY_NOTICE_DISPLAY_FIELDS.map(field =>
    item[field] === undefined || item[field] === null ? '' : item[field]
  ));
  recordPhase('displayRowsBuildMs');

  // Keep the previous complete generation readable throughout the expensive
  // source scan and projection. Readers pause only while these three prepared
  // sheets are actually being replaced.
  props.setProperty(NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY, String(Date.now()));
  const taskSheet = getOrCreateDisplaySheetLocked_(ss, TASK_DISPLAY_SHEET_NAME, TASK_DISPLAY_HEADERS, !validateDisplaySheetSchemas);
  const completedTaskSheet = getOrCreateDisplaySheetLocked_(ss, COMPLETED_TASK_DISPLAY_SHEET_NAME, TASK_DISPLAY_HEADERS, !validateDisplaySheetSchemas);
  const noticeSheet = getOrCreateDisplaySheetLocked_(ss, UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME, UNIVERSITY_NOTICE_DISPLAY_HEADERS, !validateDisplaySheetSchemas);
  if (validateDisplaySheetSchemas) {
    props.setProperty(NOTIFICATION_DISPLAY_SCHEMA_CACHE_PROPERTY,
      `${Date.now()}|${getNotificationDisplaySchemaCacheKey_(ss)}`);
  }
  recordPhase('displaySheetPrepareMs');

  let phaseWriteStartedAt = Date.now();
  replaceDisplaySheetRows_(taskSheet, TASK_DISPLAY_HEADERS, taskRows);
  phaseMs.taskSheetWriteMs = Date.now() - phaseWriteStartedAt;
  phaseWriteStartedAt = Date.now();
  replaceDisplaySheetRows_(completedTaskSheet, TASK_DISPLAY_HEADERS, completedTaskRows);
  phaseMs.completedTaskSheetWriteMs = Date.now() - phaseWriteStartedAt;
  phaseWriteStartedAt = Date.now();
  replaceDisplaySheetRows_(noticeSheet, UNIVERSITY_NOTICE_DISPLAY_HEADERS, noticeRows);
  phaseMs.noticeSheetWriteMs = Date.now() - phaseWriteStartedAt;
  phaseStartedAt = Date.now();
  const displayGeneration = String(Date.now()) + ':' + Utilities.getUuid();
  const completeSnapshot = stageCompleteDisplaySnapshotLocked_(ss, activeTasks, completedTasks,
    mergedNotices, displayGeneration, String(props.getProperty(TASK_DISPLAY_STATUS_GENERATION_PROPERTY) || '0'));
  recordPhase('completeSnapshotStageMs');
  SpreadsheetApp.flush();
  recordPhase('flushMs');
  phaseStartedAt = Date.now();
  props.setProperty(NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY, NOTIFICATION_DISPLAY_DATA_REVISION);
  props.setProperty(NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY, displayGeneration);
  const firstPaintStartedAt = Date.now();
  const firstPaintProperties = {
    [NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY]: displayGeneration,
    [TASK_DISPLAY_STATUS_GENERATION_PROPERTY]: String(props.getProperty(TASK_DISPLAY_STATUS_GENERATION_PROPERTY) || '0')
  };
  writeTaskFirstPaintData_(activeTasks, firstPaintProperties, ss.getId());
  writeUniversityFirstPaintData_(mergedNotices, firstPaintProperties, ss.getId());
  phaseMs.firstPaintDataWriteMs = Date.now() - firstPaintStartedAt;
  publishCompleteDisplaySnapshotLocked_(completeSnapshot);
  props.deleteProperty(NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY);
  recordPhase('displayMetadataCommitMs');
  const displayCacheWarmStartedAt = Date.now();
  let displayCacheEntryCount = 0;
  if (props.getProperty(TEST_CASE_MODE_PROPERTY) !== 'true') {
    const displayCacheProperties = {
      [NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY]: NOTIFICATION_DISPLAY_DATA_REVISION,
      [NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY]: displayGeneration,
      [TASK_DISPLAY_STATUS_GENERATION_PROPERTY]: String(props.getProperty(TASK_DISPLAY_STATUS_GENERATION_PROPERTY) || '0')
    };
    displayCacheEntryCount = writeTaskDisplayCachesAfterSync_([
      {cacheKey: getTaskDisplayCacheKey_(displayCacheProperties, '未完了'), items: activeTasks},
      {cacheKey: getTaskDisplayCacheKey_(displayCacheProperties, '完了'), items: completedTasks}
    ]);
  }
  phaseMs.taskDisplayCacheWarmMs = Date.now() - displayCacheWarmStartedAt;

  const result = {
    taskCount: taskRows.length + completedTaskRows.length,
    activeTaskCount: taskRows.length,
    completedTaskCount: completedTaskRows.length,
    noticeCount: noticeRows.length,
    taskDisplayCacheEntryCount: displayCacheEntryCount
  };
  Logger.log('TASKHUB_DISPLAY_DATA_BUILD ' + JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    phaseMs,
    sheetReadMs: readContext.sheetReadMs,
    sheetRowCounts: readContext.sheetRowCounts,
    ...result
  }));
  return result;
}

function prepareTaskDisplayItemsForSync_(items, status, referenceNow) {
  const now = referenceNow instanceof Date ? referenceNow : new Date();
  const prepared = items.map(item => {
    const deadline = item && item.dueType === 'detected'
      ? buildDeadlineDateTimeForWeb_(item.dueDateKey, item.dueTime)
      : null;
    item.deadlineAtTime = deadline ? deadline.getTime() : '';
    return item;
  })
    .filter(item => status === '完了' ? item.status === '完了' : item.status !== '完了')
    .filter(item => !isNotYetPublishedClassroomApiNotificationForWeb_(item, now))
    .filter(item => !isExpiredNotificationForWeb_(item, now))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item, now));

  if (status === '完了') {
    prepared.forEach(item => {
      item.displayDueGroupKey = 'completed';
      item.displayDueGroupIndex = 0;
    });
    prepared.sort((a, b) => {
      const completedDelta = Number(b.completedAtTime || 0) - Number(a.completedAtTime || 0);
      return completedDelta || getTaskDisplayReceivedTime_(b) - getTaskDisplayReceivedTime_(a);
    });
    return attachTaskDisplayGroupSummaries_(prepared);
  }

  prepared.forEach(item => {
    const group = getTaskDueDisplayGroup_(item, now);
    item.displayDueGroupKey = group.key;
    item.displayDueGroupIndex = group.index;
  });
  prepared.sort((a, b) => {
    const groupDelta = Number(a.displayDueGroupIndex) - Number(b.displayDueGroupIndex);
    if (groupDelta) return groupDelta;
    const leftDeadline = Number(a.deadlineAtTime || 0);
    const rightDeadline = Number(b.deadlineAtTime || 0);
    if (leftDeadline && rightDeadline && leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
    return getTaskDisplayReceivedTime_(b) - getTaskDisplayReceivedTime_(a);
  });
  return attachTaskDisplayGroupSummaries_(prepared);
}

function attachTaskDisplayGroupSummaries_(items) {
  const summaries = new Map();
  items.forEach(item => {
    const key = String(item.displayDueGroupKey || 'unknown');
    if (!summaries.has(key)) summaries.set(key, {count: 0, courseCounts: new Map()});
    const summary = summaries.get(key);
    summary.count++;
    const courseName = String(item.courseName || '授業名未抽出');
    summary.courseCounts.set(courseName, (summary.courseCounts.get(courseName) || 0) + 1);
  });

  const firstItemByGroup = new Set();
  items.forEach(item => {
    const key = String(item.displayDueGroupKey || 'unknown');
    const summary = summaries.get(key);
    item.displayDueGroupCount = summary ? summary.count : 0;
    if (summary && !firstItemByGroup.has(key)) {
      firstItemByGroup.add(key);
      item.displayDueGroupCourseCountsJson = JSON.stringify(
        Array.from(summary.courseCounts.entries()).sort((left, right) => left[0].localeCompare(right[0], 'ja'))
      );
    } else {
      item.displayDueGroupCourseCountsJson = '';
    }
  });
  return items;
}

function getTaskDueDisplayGroup_(item, referenceNow) {
  if (item && item.dueType === 'none') return TASK_DUE_DISPLAY_GROUPS[5];
  if (!item || item.dueType === 'unknown' || !item.dueDateKey) return TASK_DUE_DISPLAY_GROUPS[6];

  const deadline = buildDeadlineDateTimeForWeb_(item.dueDateKey, item.dueTime);
  if (!deadline) return TASK_DUE_DISPLAY_GROUPS[6];
  if (deadline.getTime() < referenceNow.getTime()) return TASK_DUE_DISPLAY_GROUPS[0];

  const dueDateKey = normalizeNotificationDisplayDateKey_(item.dueDateKey);
  const today = Utilities.formatDate(referenceNow, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const [year, month, day] = today.split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const tomorrowDate = new Date(calendarDate.getTime());
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const toDateKey = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  const tomorrow = toDateKey(tomorrowDate);
  if (dueDateKey === today) return TASK_DUE_DISPLAY_GROUPS[1];
  if (dueDateKey === tomorrow) return TASK_DUE_DISPLAY_GROUPS[2];

  const endOfWeek = new Date(calendarDate.getTime());
  endOfWeek.setUTCDate(endOfWeek.getUTCDate() + ((7 - endOfWeek.getUTCDay()) % 7));
  const endOfWeekKey = toDateKey(endOfWeek);
  if (dueDateKey <= endOfWeekKey) return TASK_DUE_DISPLAY_GROUPS[3];
  return TASK_DUE_DISPLAY_GROUPS[4];
}

function getTaskDisplayReceivedTime_(item) {
  return Number(item && (item.displayReceivedAtTime || item.receivedAtTime) || 0);
}

function taskDisplayItemToRow_(item) {
  return TASK_DISPLAY_FIELDS.map(field => {
    if (field === 'gmailMessageIds') return JSON.stringify(Array.isArray(item.gmailMessageIds) ? item.gmailMessageIds : []);
    return item[field] === undefined || item[field] === null ? '' : item[field];
  });
}

function refreshNotificationDisplayDataAfterSyncLocked_(spreadsheet, label, rebuildOptions) {
  try {
    return rebuildNotificationDisplayDataLocked_(spreadsheet, rebuildOptions);
  } catch (error) {
    const props = PropertiesService.getUserProperties();
    const writeWasStarted = hasNotificationDisplayDataWriteMarker_(props.getProperties());
    if (writeWasStarted) props.deleteProperty(NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY);
    props.deleteProperty(NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY);
    Logger.log('TASKHUB_DISPLAY_DATA_BUILD_FAILED ' + JSON.stringify({
      label: String(label || 'sync'),
      error: String(error && error.message ? error.message : error),
      previousGenerationPreserved: !writeWasStarted
    }));
    return {ok: false, error: String(error && error.message ? error.message : error), previousGenerationPreserved: !writeWasStarted};
  }
}

function refreshNotificationDisplayDataAfterCombinedSync_(label) {
  try {
    return runWithUserLock_('表示用データ更新', () =>
      refreshNotificationDisplayDataAfterSyncLocked_(getOrCreateSpreadsheetLocked_(), label || 'combined-sync'));
  } catch (error) {
    Logger.log('TASKHUB_DISPLAY_DATA_REFRESH_DEFERRED ' + JSON.stringify({
      label: String(label || 'combined-sync'),
      error: String(error && error.message ? error.message : error)
    }));
    return {ok: false, error: String(error && error.message ? error.message : error)};
  }
}

function getOrCreateDisplaySheetLocked_(spreadsheet, name, headers, skipSchemaValidation) {
  let sheet = spreadsheet.getSheetByName(name);
  const isNewSheet = !sheet;
  if (isNewSheet) sheet = spreadsheet.insertSheet(name);
  if (skipSchemaValidation && !isNewSheet) return sheet;
  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(sheet.getLastColumn(), headers.length);
  const currentHeader = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const matches = headers.every((header, index) => currentHeader[index] === header);
  const isLegacyTaskDisplaySheet = [TASK_DISPLAY_SHEET_NAME, COMPLETED_TASK_DISPLAY_SHEET_NAME].includes(name) &&
    headers.length === TASK_DISPLAY_HEADERS.length &&
    LEGACY_TASK_DISPLAY_HEADERS.every((header, index) => currentHeader[index] === header) &&
    currentHeader.slice(LEGACY_TASK_DISPLAY_HEADERS.length).every(value => value === '' || value === null || value === undefined);
  const isPreviousTaskDisplaySheet = [TASK_DISPLAY_SHEET_NAME, COMPLETED_TASK_DISPLAY_SHEET_NAME].includes(name) &&
    PREVIOUS_TASK_DISPLAY_HEADERS.every((header, index) => currentHeader[index] === header) &&
    currentHeader.slice(PREVIOUS_TASK_DISPLAY_HEADERS.length).every(value => value === '' || value === null || value === undefined);
  const isPreviousUniversityNoticeDisplaySheet = name === UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME &&
    PREVIOUS_UNIVERSITY_NOTICE_DISPLAY_HEADERS.every((header, index) => currentHeader[index] === header) &&
    currentHeader.slice(PREVIOUS_UNIVERSITY_NOTICE_DISPLAY_HEADERS.length).every(value => value === '' || value === null || value === undefined);
  const hasExistingData = !matches && lastRow > 1 && sheet.getDataRange().getValues().slice(1)
    .some(row => row.some(value => value !== '' && value !== null && value !== undefined));
  if (!matches && hasExistingData && !isLegacyTaskDisplaySheet && !isPreviousTaskDisplaySheet && !isPreviousUniversityNoticeDisplaySheet) {
    throw new Error(`表示データシート「${name}」の既存データ形式が異なるため、上書きを中止しました。`);
  }
  if (!matches) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (typeof sheet.setFrozenRows === 'function') sheet.setFrozenRows(1);
  }
  return sheet;
}

function replaceDisplaySheetRows_(sheet, headers, rows) {
  if (!rows.every(row => Array.isArray(row) && row.length === headers.length)) {
    throw new Error(`表示データシート「${sheet.getName()}」の保存列数が見出しと一致しません。`);
  }
  const oldCount = Math.max(0, sheet.getLastRow() - 1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows.map(row => toSafeSpreadsheetRow_(row)));
  }
  if (oldCount > rows.length) {
    sheet.getRange(rows.length + 2, 1, oldCount - rows.length, headers.length).clearContent();
  }
}

function addStoredTaskDateChecks_(item) {
  const deadline = item.dueType === 'detected'
    ? buildDeadlineDateTimeForWeb_(item.dueDateKey, item.dueTime)
    : null;
  item.deadlineAtTime = deadline instanceof Date && !Number.isNaN(deadline.getTime())
    ? deadline.getTime()
    : '';
  const retentionDays = String(item.messageId || '').startsWith('classroom-api:') ? 21 : 7;
  const receivedAtTime = Number(item.receivedAtTime || 0);
  item.staleAtTime = item.dueType === 'unknown' && Number.isFinite(receivedAtTime) && receivedAtTime > 0
    ? receivedAtTime + retentionDays * 24 * 60 * 60 * 1000
    : '';
  return item;
}

function getUniversityNoticeExpiryTimeForDisplay_(row) {
  const processed = getNotificationProcessedData_(row);
  if (processed && Object.prototype.hasOwnProperty.call(processed, 'expiresAt')) {
    return processed.expiresAt === null ? '' : Number(processed.expiresAt);
  }
  const received = parseNotificationReceivedDate_(row && row[9]);
  if (!received) return '';
  if (String(row[2] || '') === 'Google Classroom') {
    const parsed = getClassroomNoticeExpiry_(row[11], received);
    return parsed === null ? received.getTime() + 14 * 24 * 60 * 60 * 1000 : parsed;
  }
  if (String(row[2] || '') === 'inCampus') {
    const expiry = getInCampusNoticeExpiry_(received);
    return expiry === null ? '' : expiry;
  }
  return '';
}

function readMaterializedTaskItems_(spreadsheet, status, userProperties) {
  if (!isNotificationDisplayDataCurrent_(userProperties)) return null;
  const sheetName = status === '完了' ? COMPLETED_TASK_DISPLAY_SHEET_NAME : TASK_DISPLAY_SHEET_NAME;
  const sheet = spreadsheet && spreadsheet.getSheetByName(sheetName);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  const readStartedAt = Date.now();
  const values = sheet.getRange(1, 1, lastRow, TASK_DISPLAY_HEADERS.length).getValues();
  const getValuesMs = Date.now() - readStartedAt;
  const header = values[0] || [];
  if (!TASK_DISPLAY_HEADERS.every((value, index) => header[index] === value)) {
    invalidateNotificationDisplaySchemaCache_();
    return null;
  }
  if (values.length < 2) {
    Logger.log('TASKHUB_MATERIALIZED_READ_TIMING ' + JSON.stringify({sheetName, lastRow, columns: TASK_DISPLAY_HEADERS.length, getValuesMs, mapMs: 0, itemCount: 0}));
    return [];
  }
  const mapStartedAt = Date.now();
  const items = values.slice(1).map(taskDisplayRowToItem_).filter(item => String(item.messageId || ''));
  Logger.log('TASKHUB_MATERIALIZED_READ_TIMING ' + JSON.stringify({sheetName, lastRow, columns: TASK_DISPLAY_HEADERS.length, getValuesMs, mapMs: Date.now() - mapStartedAt, itemCount: items.length}));
  return items;
}

function taskDisplayRowToItem_(row) {
    const item = {};
    TASK_DISPLAY_FIELDS.forEach((field, index) => { item[field] = row[index] === null ? '' : row[index]; });
    try { item.gmailMessageIds = JSON.parse(String(item.gmailMessageIds || '[]')); }
    catch (_) { item.gmailMessageIds = []; }
    item.receivedAtTime = Number(item.receivedAtTime || 0);
    item.displayReceivedAtTime = Number(item.displayReceivedAtTime || 0);
    item.gmailReceivedAtTime = Number(item.gmailReceivedAtTime || 0);
    item.completedAtTime = Number(item.completedAtTime || 0);
    item.deadlineAtTime = item.deadlineAtTime === '' ? null : Number(item.deadlineAtTime);
    item.staleAtTime = item.staleAtTime === '' ? null : Number(item.staleAtTime);
    item.displayDueGroupIndex = Number(item.displayDueGroupIndex || 0);
    item.displayDueGroupCount = Number(item.displayDueGroupCount || 0);
    item.dueDateKey = normalizeNotificationDisplayDateKey_(item.dueDateKey);
    item.dueTime = normalizeNotificationDisplayTime_(item.dueTime);
    return toNotificationWebSafeValue_(item);
}

function readMaterializedUniversityNotices_(spreadsheet, userProperties) {
  if (!isNotificationDisplayDataCurrent_(userProperties)) return null;
  const sheet = spreadsheet && spreadsheet.getSheetByName(UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  const readStartedAt = Date.now();
  const values = sheet.getRange(1, 1, lastRow, UNIVERSITY_NOTICE_DISPLAY_HEADERS.length).getValues();
  const getValuesMs = Date.now() - readStartedAt;
  const header = values[0] || [];
  if (!UNIVERSITY_NOTICE_DISPLAY_HEADERS.every((value, index) => header[index] === value)) {
    invalidateNotificationDisplaySchemaCache_();
    return null;
  }
  if (values.length < 2) {
    Logger.log('TASKHUB_MATERIALIZED_READ_TIMING ' + JSON.stringify({sheetName: UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME, lastRow, columns: UNIVERSITY_NOTICE_DISPLAY_HEADERS.length, getValuesMs, mapMs: 0, itemCount: 0}));
    return [];
  }
  const mapStartedAt = Date.now();
  const items = values.slice(1).map(row => {
    const item = {};
    UNIVERSITY_NOTICE_DISPLAY_FIELDS.forEach((field, index) => { item[field] = row[index] === null ? '' : row[index]; });
    item.receivedAtTime = Number(item.receivedAtTime || 0);
    item.expiresAtTime = item.expiresAtTime === '' ? null : Number(item.expiresAtTime);
    return toNotificationWebSafeValue_(item);
  }).filter(item => String(item.messageId || ''));
  Logger.log('TASKHUB_MATERIALIZED_READ_TIMING ' + JSON.stringify({sheetName: UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME, lastRow, columns: UNIVERSITY_NOTICE_DISPLAY_HEADERS.length, getValuesMs, mapMs: Date.now() - mapStartedAt, itemCount: items.length}));
  return items;
}

function readMaterializedUniversityNoticeList_(spreadsheet, userProperties, noticeStates) {
  if (!isNotificationDisplayDataCurrent_(userProperties)) return null;
  const sheet = spreadsheet && spreadsheet.getSheetByName(UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  const stateIdIndex = UNIVERSITY_NOTICE_DISPLAY_FIELDS.indexOf('originalMessageIdForState');
  const readWidth = stateIdIndex + 1;
  const readStartedAt = Date.now();
  // Read only compact list columns plus the Gmail ID used for state matching.
  // The body, expiry, and extraction-link columns are unnecessary at page boot.
  const values = sheet.getRange(1, 1, lastRow, readWidth).getValues();
  const getValuesMs = Date.now() - readStartedAt;
  const header = values[0] || [];
  if (!UNIVERSITY_NOTICE_DISPLAY_HEADERS.slice(0, readWidth).every((value, index) => header[index] === value)) return null;
  if (values.length < 2) {
    Logger.log('TASKHUB_MATERIALIZED_READ_TIMING ' + JSON.stringify({
      sheetName: UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME,
      lastRow,
      columns: readWidth,
      bodyColumnRead: false,
      getValuesMs,
      mapMs: 0,
      itemCount: 0
    }));
    return [];
  }
  const mapStartedAt = Date.now();
  const statePrefix = getUniversityNoticeStatePrefix_(false);
  const stateMap = noticeStates || {};
  const items = [];
  values.slice(1).forEach(row => {
    const messageId = String(row[0] || '');
    if (!messageId) return;
    let state = {};
    const originalMessageId = String(row[stateIdIndex] || '');
    const savedState = stateMap[statePrefix + messageId] ||
      (originalMessageId ? stateMap[statePrefix + originalMessageId] : '') || '{}';
    try { state = JSON.parse(savedState); } catch (_) {}
    items.push({
      messageId,
      source: String(row[1] || ''),
      title: String(row[2] || ''),
      courseName: String(row[3] || ''),
      from: String(row[4] || ''),
      receivedAt: formatDateForWeb_(row[5]),
      receivedAtTime: Number(row[6] || 0),
      gmailLink: String(row[7] || ''),
      preview: String(row[8] || ''),
      read: Boolean(state.read),
      saved: Boolean(state.saved)
    });
  });
  Logger.log('TASKHUB_MATERIALIZED_READ_TIMING ' + JSON.stringify({
    sheetName: UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME,
    lastRow,
    columns: readWidth,
    bodyColumnRead: false,
    getValuesMs,
    mapMs: Date.now() - mapStartedAt,
    itemCount: items.length
  }));
  return items;
}

function buildUniversityNoticeDisplayItems_(noticeItems, extractedItems, testMode) {
  const merged = mergeNotificationAndInCampusExtractedItemsForWeb_(
    noticeItems,
    extractedItems,
    'announcement',
    Boolean(testMode)
  );
  // Persisted production rows and test projections share this ordering step.
  merged.sort((a, b) => b.receivedAtTime - a.receivedAtTime);
  return merged.map(item => toNotificationWebSafeValue_(Object.assign({}, item, {
    preview: createUniversityNoticePreview_(item && item.body)
  })));
}

function createUniversityNoticePreview_(body) {
  const normalized = String(body || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? normalized.slice(0, 179) + '…' : normalized;
}

function filterUniversityNoticeDisplayItemsForNow_(items, referenceNow) {
  const now = referenceNow instanceof Date ? referenceNow.getTime() : Date.now();
  return items.filter(item => item.expiresAtTime === null || item.expiresAtTime === '' ||
    !Number.isFinite(Number(item.expiresAtTime)) || now < Number(item.expiresAtTime));
}

function getTaskDisplayCacheKey_(properties, status) {
  const values = properties || {};
  const generation = String(values[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || 'legacy');
  const statusGeneration = String(values[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0');
  return [TASK_DISPLAY_CACHE_PREFIX, NOTIFICATION_DISPLAY_DATA_REVISION,
    status === '完了' ? 'completed' : 'active', generation, statusGeneration].join(':');
}

function getTaskDisplayPayloadForWeb(status, userPropertiesSnapshot, preferFirstPaint, preferCommittedList) {
  const startedAt = Date.now();
  const propertiesStartedAt = Date.now();
  const viewStatus = status === '完了' || status === 'completed' ? '完了' : '未完了';
  const properties = userPropertiesSnapshot || PropertiesService.getUserProperties().getProperties();
  if (preferCommittedList === true) {
    const complete = getCompleteDisplayPayloadForWeb_(viewStatus, properties, false);
    if (complete) return complete;
  }
  if (preferFirstPaint === true && viewStatus === '未完了') {
    const firstPaint = getFirstPaintPayloadForWeb_('assignment', properties);
    if (firstPaint) return firstPaint;
  }
  const propertiesMs = userPropertiesSnapshot ? 0 : Date.now() - propertiesStartedAt;
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  const candidateCacheToken = testMode || properties[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] !== NOTIFICATION_DISPLAY_DATA_REVISION
    ? ''
    : getTaskDisplayCacheKey_(properties, viewStatus);
  const dataStartedAt = Date.now();
  const readResult = viewStatus === '完了'
    ? getCompletedNotificationsForWebLocked_(properties, true)
    : getNotificationsForWebLocked_(properties, true);
  const items = readResult.items;
  const cacheHit = readResult.cacheHit === true;
  if (!testMode && !cacheHit) {
    const latestProperties = PropertiesService.getUserProperties().getProperties();
    const generationBeforeRead = String(properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || '');
    const generationAfterRead = String(latestProperties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || '');
    if (!isNotificationDisplayDataCurrent_(latestProperties) || generationBeforeRead !== generationAfterRead) {
      throw new Error('課題表示データを更新中です。表示データの更新後に再試行します。');
    }
  }
  // A hit means sync already populated this exact generation. Do not issue a
  // redundant browser RPC to write the same items after they have rendered.
  const cacheToken = cacheHit ? '' : candidateCacheToken;
  const dataMs = Date.now() - dataStartedAt;
  const clockStateStartedAt = Date.now();
  const testCaseClockState = getTestCaseClockStateForWeb(properties);
  Logger.log('TASKHUB_TASK_PAYLOAD_TIMING ' + JSON.stringify({
    propertiesMs,
    dataMs,
    clockStateMs: Date.now() - clockStateStartedAt,
    totalMs: Date.now() - startedAt,
    status: viewStatus,
    itemCount: items.length,
    cacheHit,
    cacheTokenAvailable: Boolean(cacheToken)
  }));
  return {items, cacheToken, status: viewStatus, testCaseClockState};
}

function cacheTaskDisplayItemsAfterWebDisplay(items, status, cacheToken) {
  if (!Array.isArray(items) || items.length > 1500) return false;
  const viewStatus = status === '完了' || status === 'completed' ? '完了' : '未完了';
  const properties = PropertiesService.getUserProperties().getProperties();
  if (properties[TEST_CASE_MODE_PROPERTY] === 'true' ||
      properties[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] !== NOTIFICATION_DISPLAY_DATA_REVISION ||
      isNotificationDisplayDataBuilding_(properties) ||
      String(cacheToken || '') !== getTaskDisplayCacheKey_(properties, viewStatus)) return false;
  if (items.some(item => !item || !item.messageId ||
      (viewStatus === '完了' ? item.status !== '完了' : item.status === '完了'))) return false;
  return writeTaskDisplayCache_(String(cacheToken), items);
}

function readTaskDisplayCache_(properties, status) {
  if (typeof CacheService === 'undefined' || typeof CacheService.getUserCache !== 'function') return null;
  const values = properties || {};
  if (values[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] !== NOTIFICATION_DISPLAY_DATA_REVISION) return null;
  const cacheKey = getTaskDisplayCacheKey_(values, status);
  try {
    const value = CacheService.getUserCache().get(cacheKey);
    if (!value) return null;
    const serialized = value.startsWith('gz:')
      ? Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(value.slice(3)), 'application/gzip')).getDataAsString('UTF-8')
      : value.startsWith('json:') ? value.slice(5) : '';
    if (!serialized) return null;
    const items = JSON.parse(serialized);
    if (!Array.isArray(items)) return null;
    return {cacheKey, items};
  } catch (error) {
    Logger.log('TASKHUB_TASK_DISPLAY_CACHE_READ_FAILED ' + String(error && error.message ? error.message : error));
    return null;
  }
}

function writeTaskDisplayCache_(cacheKey, items) {
  if (!cacheKey || typeof CacheService === 'undefined' || typeof CacheService.getUserCache !== 'function') return false;
  try {
    const encoded = encodeTaskDisplayCacheValue_(items);
    if (!encoded) return false;
    CacheService.getUserCache().put(cacheKey, encoded, TASK_DISPLAY_CACHE_TTL_SECONDS);
    return true;
  } catch (error) {
    Logger.log('TASKHUB_TASK_DISPLAY_CACHE_WRITE_FAILED ' + String(error && error.message ? error.message : error));
    return false;
  }
}

function encodeTaskDisplayCacheValue_(items) {
  if (!Array.isArray(items) || items.length > 1500) return '';
  const json = JSON.stringify(items);
  let encoded = 'json:' + json;
  try {
    const compressed = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
    const gzipEncoded = 'gz:' + Utilities.base64Encode(compressed.getBytes());
    if (gzipEncoded.length < encoded.length) encoded = gzipEncoded;
  } catch (_) {
    // Keep the plain JSON fallback for local shims and older Apps Script runtimes.
  }
  return encoded.length <= TASK_DISPLAY_CACHE_MAX_VALUE_LENGTH ? encoded : '';
}

/** Warm the two task views during background sync so the next page load avoids Sheets. */
function writeTaskDisplayCachesAfterSync_(entries) {
  if (typeof CacheService === 'undefined' || typeof CacheService.getUserCache !== 'function') return 0;
  const values = Object.create(null);
  (Array.isArray(entries) ? entries : []).forEach(entry => {
    if (!entry || !entry.cacheKey) return;
    const encoded = encodeTaskDisplayCacheValue_(entry.items);
    if (encoded) values[entry.cacheKey] = encoded;
  });
  const keys = Object.keys(values);
  if (!keys.length) return 0;
  try {
    const cache = CacheService.getUserCache();
    if (typeof cache.putAll === 'function') {
      cache.putAll(values, TASK_DISPLAY_CACHE_TTL_SECONDS);
    } else {
      keys.forEach(key => cache.put(key, values[key], TASK_DISPLAY_CACHE_TTL_SECONDS));
    }
    return keys.length;
  } catch (error) {
    Logger.log('TASKHUB_TASK_DISPLAY_CACHE_WARM_FAILED ' + String(error && error.message ? error.message : error));
    return 0;
  }
}

function getUniversityNoticeCacheKey_(properties, testMode, referenceNow) {
  const stateGeneration = String(properties[UNIVERSITY_NOTICE_STATE_GENERATION_PROPERTY] || '0');
  if (testMode) {
    const now = referenceNow instanceof Date ? referenceNow : new Date();
    const clockKey = properties[TEST_CASE_CLOCK_PROPERTY] ||
      Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
    const sessionKey = String(properties[TEST_CASE_SESSION_STARTED_AT_PROPERTY] || 'no-session');
    return [UNIVERSITY_NOTICE_CACHE_PREFIX, 'test', clockKey, sessionKey, stateGeneration].join(':');
  }
  const generation = String(properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || 'legacy');
  return [UNIVERSITY_NOTICE_CACHE_PREFIX, 'production', NOTIFICATION_DISPLAY_DATA_REVISION,
    generation, stateGeneration].join(':');
}

function readUniversityNoticeCache_(properties, testMode, referenceNow) {
  if (typeof CacheService === 'undefined' || typeof CacheService.getUserCache !== 'function') return null;
  if (!testMode) {
    if (properties[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] !== NOTIFICATION_DISPLAY_DATA_REVISION) return null;
  }

  const cacheKey = getUniversityNoticeCacheKey_(properties, testMode, referenceNow);
  try {
    const value = CacheService.getUserCache().get(cacheKey);
    if (!value) return null;
    const serialized = value.startsWith('gz:')
      ? Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(value.slice(3)), 'application/gzip')).getDataAsString('UTF-8')
      : value.startsWith('json:') ? value.slice(5) : '';
    if (!serialized) return null;
    const items = JSON.parse(serialized);
    if (!Array.isArray(items)) return null;
    return {cacheKey, items};
  } catch (error) {
    Logger.log('TASKHUB_UNIVERSITY_NOTICE_CACHE_READ_FAILED ' + String(error && error.message ? error.message : error));
    return null;
  }
}

function writeUniversityNoticeCache_(cacheKey, items) {
  if (typeof CacheService === 'undefined' || typeof CacheService.getUserCache !== 'function') return false;
  try {
    const json = JSON.stringify(items);
    let encoded = 'json:' + json;
    try {
      const compressed = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
      const gzipEncoded = 'gz:' + Utilities.base64Encode(compressed.getBytes());
      if (gzipEncoded.length < encoded.length) encoded = gzipEncoded;
    } catch (_) {
      // Older local test shims may not implement Utilities.gzip; plain JSON is
      // still safe when it fits the documented per-key cache limit.
    }
    if (encoded.length > UNIVERSITY_NOTICE_CACHE_MAX_VALUE_LENGTH) return false;
    CacheService.getUserCache().put(cacheKey, encoded, UNIVERSITY_NOTICE_CACHE_TTL_SECONDS);
    return true;
  } catch (error) {
    Logger.log('TASKHUB_UNIVERSITY_NOTICE_CACHE_WRITE_FAILED ' + String(error && error.message ? error.message : error));
    return false;
  }
}

function getMaterializedTaskItemsForWeb_(spreadsheet, status, userProperties) {
  // This reader intentionally does not filter, classify, expiry-check, or sort.
  return readMaterializedTaskItems_(spreadsheet, status, userProperties);
}

function getMaterializedUniversityNoticesForWeb_(spreadsheet, referenceNow, states, userProperties) {
  const items = readMaterializedUniversityNotices_(spreadsheet, userProperties);
  if (!items) return null;
  const statePrefix = getUniversityNoticeStatePrefix_(false);
  const stateMap = states || {};
  const result = items.map(item => {
    let state = {};
    const storedState = stateMap[statePrefix + item.messageId] ||
      (item.originalMessageIdForState ? stateMap[statePrefix + item.originalMessageIdForState] : '') || '{}';
    try { state = JSON.parse(storedState); } catch (_) {}
    return Object.assign(item, {read: Boolean(state.read), saved: Boolean(state.saved)});
  });
  // The display table is sorted and expiry-filtered during sync; this is an
  // overlay of per-user state only and deliberately does not evaluate dates.
  return result;
}

function getMaterializedUniversityNoticeListForWeb_(spreadsheet, states, userProperties) {
  return readMaterializedUniversityNoticeList_(spreadsheet, userProperties, states);
}

function updateMaterializedTaskStatusLocked_(spreadsheet, messageId, status, completedAt) {
  if (!isNotificationDisplayDataCurrent_()) return false;
  const activeSheet = spreadsheet && spreadsheet.getSheetByName(TASK_DISPLAY_SHEET_NAME);
  const completedSheet = spreadsheet && spreadsheet.getSheetByName(COMPLETED_TASK_DISPLAY_SHEET_NAME);
  if (!activeSheet || !completedSheet) return false;
  const idColumn = TASK_DISPLAY_FIELDS.indexOf('messageId') + 1;
  const statusColumn = TASK_DISPLAY_FIELDS.indexOf('status') + 1;
  const completedAtColumn = TASK_DISPLAY_FIELDS.indexOf('completedAt') + 1;
  const completedAtTimeColumn = TASK_DISPLAY_FIELDS.indexOf('completedAtTime') + 1;
  const sourceStatus = status === '完了' ? '未完了' : '完了';
  const sourceSheet = sourceStatus === '完了' ? completedSheet : activeSheet;
  const targetSheet = status === '完了' ? completedSheet : activeSheet;
  const sourceRowNumber = findTaskDisplayRowNumber_(sourceSheet, messageId, idColumn);
  if (sourceRowNumber < 0) return false;
  const rowValues = sourceSheet.getRange(sourceRowNumber, 1, 1, TASK_DISPLAY_HEADERS.length).getValues()[0];
  const completedValue = status === '完了' ? (completedAt || new Date()) : '';
  rowValues[statusColumn - 1] = status;
  rowValues[completedAtColumn - 1] = formatDateForWeb_(completedValue);
  rowValues[completedAtTimeColumn - 1] = getTimeForSort_(completedValue);
  if (sourceSheet === targetSheet) {
    sourceSheet.getRange(sourceRowNumber, 1, 1, TASK_DISPLAY_HEADERS.length).setValues([rowValues]);
  } else {
    sourceSheet.deleteRow(sourceRowNumber);
    insertTaskDisplayRowInOrder_(targetSheet, rowValues, status);
  }
  const activeRows = refreshTaskDisplayGroupSummariesInSheet_(activeSheet, '未完了');
  const completedRows = refreshTaskDisplayGroupSummariesInSheet_(completedSheet, '完了');
  const props = PropertiesService.getUserProperties();
  props.setProperty(
    TASK_DISPLAY_STATUS_GENERATION_PROPERTY,
    String(Date.now()) + ':' + Utilities.getUuid()
  );
  const properties = props.getProperties();
  writeTaskFirstPaintData_(activeRows.map(taskDisplayRowToItem_), properties, spreadsheet.getId());
  try {
    refreshCompleteSnapshotTaskStatusLocked_(spreadsheet, activeRows, completedRows, properties);
  } catch (error) {
    // The status epoch already changed, so an older task projection is rejected
    // and readers fall back to the updated display rows if publication fails.
    Logger.log('TASKHUB_COMPLETE_SNAPSHOT_STATUS_FAILED ' + String(error && error.message || error));
  }
  return true;
}

function refreshTaskDisplayGroupSummariesInSheet_(sheet, status) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, TASK_DISPLAY_HEADERS.length).getValues();
  const groupIndex = TASK_DISPLAY_FIELDS.indexOf('displayDueGroupKey');
  const courseIndex = TASK_DISPLAY_FIELDS.indexOf('courseName');
  const countIndex = TASK_DISPLAY_FIELDS.indexOf('displayDueGroupCount');
  const courseCountsIndex = TASK_DISPLAY_FIELDS.indexOf('displayDueGroupCourseCountsJson');
  const summaries = new Map();
  values.forEach(row => {
    const key = status === '完了' ? 'completed' : String(row[groupIndex] || 'unknown');
    if (!summaries.has(key)) summaries.set(key, {count: 0, courseCounts: new Map()});
    const summary = summaries.get(key);
    summary.count++;
    const courseName = String(row[courseIndex] || '授業名未抽出');
    summary.courseCounts.set(courseName, (summary.courseCounts.get(courseName) || 0) + 1);
  });
  const firstItemByGroup = new Set();
  const metadata = values.map(row => {
    const key = status === '完了' ? 'completed' : String(row[groupIndex] || 'unknown');
    const summary = summaries.get(key);
    const isFirst = !firstItemByGroup.has(key);
    firstItemByGroup.add(key);
    return [summary.count, isFirst ? JSON.stringify(
      Array.from(summary.courseCounts.entries()).sort((left, right) => left[0].localeCompare(right[0], 'ja'))
    ) : ''];
  });
  sheet.getRange(2, countIndex + 1, metadata.length, 2).setValues(metadata);
  values.forEach((row, index) => {
    row[countIndex] = metadata[index][0];
    row[courseCountsIndex] = metadata[index][1];
  });
  return values;
}

function findTaskDisplayRowNumber_(sheet, messageId, idColumn) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  const ids = sheet.getRange(2, idColumn, sheet.getLastRow() - 1, 1).getValues();
  const index = ids.findIndex(row => String(row[0] || '') === String(messageId || ''));
  return index < 0 ? -1 : index + 2;
}

function compareTaskDisplayRows_(left, right, status) {
  const received = row => Number(row[TASK_DISPLAY_FIELDS.indexOf('displayReceivedAtTime')] ||
    row[TASK_DISPLAY_FIELDS.indexOf('receivedAtTime')] || 0);
  if (status === '完了') {
    const completedIndex = TASK_DISPLAY_FIELDS.indexOf('completedAtTime');
    const completedDelta = Number(right[completedIndex] || 0) - Number(left[completedIndex] || 0);
    if (completedDelta) return completedDelta;
  } else {
    const groupIndex = TASK_DISPLAY_FIELDS.indexOf('displayDueGroupIndex');
    const groupDelta = Number(left[groupIndex] || 0) - Number(right[groupIndex] || 0);
    if (groupDelta) return groupDelta;
    const deadlineIndex = TASK_DISPLAY_FIELDS.indexOf('deadlineAtTime');
    const leftDeadline = Number(left[deadlineIndex] || 0);
    const rightDeadline = Number(right[deadlineIndex] || 0);
    if (leftDeadline && rightDeadline && leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
  }
  const receivedDelta = received(right) - received(left);
  if (receivedDelta) return receivedDelta;
  return String(left[TASK_DISPLAY_FIELDS.indexOf('messageId')] || '')
    .localeCompare(String(right[TASK_DISPLAY_FIELDS.indexOf('messageId')] || ''), 'ja');
}

function insertTaskDisplayRowInOrder_(sheet, rowValues, status) {
  const lastRow = sheet.getLastRow();
  const existingRows = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, TASK_DISPLAY_HEADERS.length).getValues()
    : [];
  const index = existingRows.findIndex(row => compareTaskDisplayRows_(rowValues, row, status) < 0);
  const rowNumber = index < 0 ? lastRow + 1 : index + 2;
  sheet.insertRowsBefore(rowNumber, 1);
  sheet.getRange(rowNumber, 1, 1, TASK_DISPLAY_HEADERS.length).setValues([toSafeSpreadsheetRow_(rowValues)]);
}
