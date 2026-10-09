// A small, durable projection of the last committed display generation. It is
// prepared during sync so the first cards do not depend on CacheService/Sheets.
const FIRST_PAINT_DATA_REVISION = '2026-10-09-v1';
const TASK_FIRST_PAINT_DATA_PROPERTY = 'TASKHUB_TASK_FIRST_PAINT_DATA';
const UNIVERSITY_FIRST_PAINT_DATA_PROPERTY = 'TASKHUB_UNIVERSITY_FIRST_PAINT_DATA';
const FIRST_PAINT_PROPERTY_MAX_BYTES = 8000;
const FIRST_PAINT_TASK_LIMIT = 2;
const FIRST_PAINT_NOTICE_LIMIT = 3;

function encodeFirstPaintData_(value) {
  try {
    const json = JSON.stringify(toNotificationWebSafeValue_(value));
    const encoded = 'gz:' + Utilities.base64Encode(
      Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes());
    return encoded.length <= FIRST_PAINT_PROPERTY_MAX_BYTES ? encoded : '';
  } catch (error) {
    Logger.log('TASKHUB_FIRST_PAINT_ENCODE_FAILED ' + String(error && error.message || error));
    return '';
  }
}

function decodeFirstPaintData_(encoded) {
  try {
    if (typeof encoded !== 'string' || !encoded.startsWith('gz:') ||
        encoded.length > FIRST_PAINT_PROPERTY_MAX_BYTES) return null;
    return JSON.parse(Utilities.ungzip(Utilities.newBlob(
      Utilities.base64Decode(encoded.slice(3)), 'application/gzip')).getDataAsString('UTF-8'));
  } catch (_) { return null; }
}

function compactFirstPaintTask_(item) {
  const result = {};
  const fields = ['messageId', 'source', 'courseName', 'title', 'dueDate', 'dueStatus',
    'status', 'receivedAt', 'supplementKey', 'classroomUrl', 'gmailLink', 'dueType',
    'dueDateKey', 'dueTime', 'deadlineAtTime', 'staleAtTime', 'displayDueGroupKey',
    'displayDueGroupIndex', 'displayDueGroupCount'];
  fields.forEach(field => { result[field] = item[field] === undefined ? '' : item[field]; });
  result.firstPaintOnly = true;
  return result;
}

function makeFirstPaintEnvelope_(properties, spreadsheetId) {
  return {
    revision: FIRST_PAINT_DATA_REVISION,
    displayRevision: NOTIFICATION_DISPLAY_DATA_REVISION,
    generation: String(properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || ''),
    spreadsheetId: String(spreadsheetId || '')
  };
}

function writeTaskFirstPaintData_(items, properties, spreadsheetId) {
  const active = Array.isArray(items) ? items : [];
  const envelope = makeFirstPaintEnvelope_(properties, spreadsheetId);
  envelope.statusGeneration = String(properties[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0');
  envelope.totalCount = active.length;
  envelope.items = active.slice(0, FIRST_PAINT_TASK_LIMIT).map(compactFirstPaintTask_);
  envelope.homeSummary = ['today', 'tomorrow', 'thisWeek'].map(key => {
    const first = active.find(item => item.displayDueGroupKey === key);
    return {displayDueGroupKey: key,
      displayDueGroupCount: Number(first && first.displayDueGroupCount || 0),
      displayDueGroupCourseCountsJson: String(first && first.displayDueGroupCourseCountsJson || '[]')};
  });
  const encoded = encodeFirstPaintData_(envelope);
  const props = PropertiesService.getUserProperties();
  try {
    if (encoded) props.setProperty(TASK_FIRST_PAINT_DATA_PROPERTY, encoded);
    else props.deleteProperty(TASK_FIRST_PAINT_DATA_PROPERTY);
    return Boolean(encoded);
  } catch (error) {
    Logger.log('TASKHUB_FIRST_PAINT_WRITE_FAILED ' + String(error && error.message || error));
    return false;
  }
}

function writeUniversityFirstPaintData_(items, properties, spreadsheetId) {
  const notices = Array.isArray(items) ? items : [];
  const envelope = makeFirstPaintEnvelope_(properties, spreadsheetId);
  envelope.totalCount = notices.length;
  envelope.items = notices.slice(0, FIRST_PAINT_NOTICE_LIMIT).map(item => Object.assign(
    toUniversityNoticeListItemForWeb_(item),
    {originalMessageIdForState: String(item.originalMessageIdForState || '')}
  ));
  const encoded = encodeFirstPaintData_(envelope);
  const props = PropertiesService.getUserProperties();
  try {
    if (encoded) props.setProperty(UNIVERSITY_FIRST_PAINT_DATA_PROPERTY, encoded);
    else props.deleteProperty(UNIVERSITY_FIRST_PAINT_DATA_PROPERTY);
    return Boolean(encoded);
  } catch (error) {
    Logger.log('TASKHUB_FIRST_PAINT_WRITE_FAILED ' + String(error && error.message || error));
    return false;
  }
}

function getFirstPaintPayloadForWeb_(view, properties) {
  const values = properties || PropertiesService.getUserProperties().getProperties();
  if (values[TEST_CASE_MODE_PROPERTY] === 'true' ||
      values[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] !== NOTIFICATION_DISPLAY_DATA_REVISION) return null;
  const noticeView = view === 'university';
  const saved = decodeFirstPaintData_(values[noticeView
    ? UNIVERSITY_FIRST_PAINT_DATA_PROPERTY : TASK_FIRST_PAINT_DATA_PROPERTY]);
  const spreadsheetId = getConfiguredSpreadsheetId_() || values[USER_SPREADSHEET_ID_PROPERTY];
  if (!saved || saved.revision !== FIRST_PAINT_DATA_REVISION ||
      saved.displayRevision !== NOTIFICATION_DISPLAY_DATA_REVISION ||
      !saved.generation || saved.generation !== values[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] ||
      saved.spreadsheetId !== spreadsheetId || !Array.isArray(saved.items) ||
      saved.items.length > (noticeView ? FIRST_PAINT_NOTICE_LIMIT : FIRST_PAINT_TASK_LIMIT) ||
      !Number.isSafeInteger(saved.totalCount) || saved.totalCount < saved.items.length ||
      (saved.totalCount > 0 && saved.items.length === 0) ||
      saved.items.some(item => !item || !item.messageId)) return null;
  if (!noticeView && saved.statusGeneration !==
      String(values[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0')) return null;
  if (!noticeView && (!Array.isArray(saved.homeSummary) || saved.homeSummary.length !== 3 ||
      saved.homeSummary.some((group, index) => !group ||
        group.displayDueGroupKey !== ['today', 'tomorrow', 'thisWeek'][index] ||
        !Number.isSafeInteger(group.displayDueGroupCount) || group.displayDueGroupCount < 0 ||
        typeof group.displayDueGroupCourseCountsJson !== 'string'))) return null;

  const items = saved.items.map(item => Object.assign({}, item));
  if (noticeView) {
    const prefix = getUniversityNoticeStatePrefix_(false);
    items.forEach(item => {
      let state = {};
      try { state = JSON.parse(values[prefix + item.messageId] ||
        (item.originalMessageIdForState && values[prefix + item.originalMessageIdForState]) || '{}'); }
      catch (_) {}
      item.read = Boolean(state.read);
      item.saved = Boolean(state.saved);
      delete item.originalMessageIdForState;
    });
  }
  const payload = {items, partial: noticeView ? items.length < saved.totalCount : saved.totalCount > 0,
    totalCount: saved.totalCount, firstPaint: true,
    cacheToken: noticeView ? getUniversityNoticeCacheKey_(values, false) : '',
    testCaseClockState: getTestCaseClockStateForWeb(values)};
  if (!noticeView) {
    payload.status = '未完了';
    payload.homeSummary = saved.homeSummary;
  }
  Logger.log('TASKHUB_FIRST_PAINT_DATA_READ ' + JSON.stringify({view, itemCount: items.length,
    totalCount: saved.totalCount, partial: payload.partial, spreadsheetRead: false, cacheRead: false}));
  return payload;
}

/** Measurement only: remove this user's volatile display caches, keep saved data. */
function taskhubClearDisplayCachesForMeasurement() {
  const properties = PropertiesService.getUserProperties().getProperties();
  const cache = CacheService.getUserCache();
  const keys = [getTaskDisplayCacheKey_(properties, '未完了'),
    getTaskDisplayCacheKey_(properties, '完了'), getUniversityNoticeCacheKey_(properties, false)];
  const cachedBeforeCount = keys.filter(key => cache.get(key) !== null).length;
  keys.forEach(key => cache.remove(key));
  const cachedAfterCount = keys.filter(key => cache.get(key) !== null).length;
  const result = {ok: cachedAfterCount === 0, removedCount: keys.length, cachedBeforeCount, cachedAfterCount};
  Logger.log('TASKHUB_DISPLAY_CACHE_CLEAR ' + JSON.stringify(result));
  return result;
}
