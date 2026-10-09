// A committed, immutable list projection. Writers fill the inactive slot and
// publish one manifest only after all writes have completed. Readers keep using
// the previous complete list while the source/display sheets are being updated.
const COMPLETE_DISPLAY_SNAPSHOT_REVISION = '2026-10-09-v1';
const COMPLETE_DISPLAY_SNAPSHOT_PROPERTY = 'TASKHUB_COMPLETE_DISPLAY_SNAPSHOT';
const COMPLETE_DISPLAY_CHUNK_PREFIX = 'TASKHUB_COMPLETE_DISPLAY_CHUNK_';
const COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH = 8000;
const COMPLETE_DISPLAY_PROPERTY_MAX_LENGTH = 96000;
const COMPLETE_DISPLAY_PROPERTY_STORE_BUDGET = 400000;
const COMPLETE_DISPLAY_SHEET_CHUNK_LENGTH = 30000;
const COMPLETE_DISPLAY_MAX_ENCODED_LENGTH = 4000000;
const COMPLETE_DISPLAY_INITIAL_HTML_MAX_LENGTH = 160000;

function compactCompleteTaskListItem_(item) {
  const result = {};
  TASK_DISPLAY_FIELDS.forEach(field => {
    if (field !== 'body' && field !== 'gmailBody') result[field] = item[field] === undefined ? '' : item[field];
  });
  result.detailsDeferred = true;
  return toNotificationWebSafeValue_(result);
}

function completeDisplayDigest_(encoded) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, encoded)
    .map(value => ('0' + (value & 255).toString(16)).slice(-2)).join('');
}

function getCompleteDisplayManifest_(properties) {
  const values = properties || {};
  if (values[TEST_CASE_MODE_PROPERTY] === 'true') return null;
  try {
    const manifest = JSON.parse(values[COMPLETE_DISPLAY_SNAPSHOT_PROPERTY] || 'null');
    const spreadsheetId = getConfiguredSpreadsheetId_() || values[USER_SPREADSHEET_ID_PROPERTY] || values[LEGACY_SPREADSHEET_ID_PROPERTY];
    if (!manifest || manifest.revision !== COMPLETE_DISPLAY_SNAPSHOT_REVISION ||
        manifest.displayRevision !== NOTIFICATION_DISPLAY_DATA_REVISION ||
        manifest.spreadsheetId !== spreadsheetId || !manifest.id ||
        !['a', 'b'].includes(manifest.slot) || !manifest.displayGeneration ||
        !Number.isSafeInteger(manifest.encodedLength) || manifest.encodedLength < 1 ||
        manifest.encodedLength > COMPLETE_DISPLAY_MAX_ENCODED_LENGTH ||
        !Number.isSafeInteger(manifest.propertyChunks) || manifest.propertyChunks < 0 ||
        manifest.propertyChunks > COMPLETE_DISPLAY_PROPERTY_MAX_LENGTH / COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH ||
        !Number.isSafeInteger(manifest.sheetChunks) || manifest.sheetChunks < 1 ||
        manifest.sheetChunks !== Math.ceil(manifest.encodedLength / COMPLETE_DISPLAY_SHEET_CHUNK_LENGTH) ||
        !Number.isSafeInteger(manifest.jsonLength) || manifest.jsonLength < 1 ||
        !manifest.counts || !['active', 'completed', 'notices'].every(key =>
          Number.isSafeInteger(manifest.counts[key]) && manifest.counts[key] >= 0) ||
        !/^[a-f0-9]{64}$/.test(manifest.digest)) return null;
    return manifest;
  } catch (_) { return null; }
}

function completeDisplaySnapshotSheetName_(slot) {
  return slot === 'b' ? '表示一覧保存_B' : '表示一覧保存_A';
}

function readCompleteDisplaySnapshot_(properties, propertiesOnly) {
  const values = properties || PropertiesService.getUserProperties().getProperties();
  const manifest = getCompleteDisplayManifest_(values);
  if (!manifest) return null;
  const decode = encoded => {
    if (encoded.length !== manifest.encodedLength || completeDisplayDigest_(encoded) !== manifest.digest) return null;
    try {
      const bundle = JSON.parse(Utilities.ungzip(Utilities.newBlob(
        Utilities.base64Decode(encoded), 'application/gzip')).getDataAsString('UTF-8'));
      if (!bundle || bundle.id !== manifest.id || !['active', 'completed', 'notices'].every(key =>
        Array.isArray(bundle[key]) && bundle[key].length === manifest.counts[key] &&
        bundle[key].every(item => item && typeof item.messageId === 'string' && item.messageId))) return null;
      return {manifest, bundle};
    } catch (_) { return null; }
  };
  if (manifest.propertyChunks) {
    const chunks = Array.from({length: manifest.propertyChunks}, (_, index) =>
      values[COMPLETE_DISPLAY_CHUNK_PREFIX + manifest.slot + '_' + index] || '');
    const snapshot = chunks.every(Boolean) ? decode(chunks.join('')) : null;
    if (snapshot) return Object.assign(snapshot, {storage: 'properties'});
  }
  if (propertiesOnly) return null;
  // Large lists use the same immutable slot in Sheets. One compact range read
  // suffices; neither raw notifications nor mutable display rows are consulted.
  try {
    const spreadsheet = getSpreadsheetForRead_(values);
    const sheet = spreadsheet && spreadsheet.getSheetByName(completeDisplaySnapshotSheetName_(manifest.slot));
    if (!sheet) return null;
    const rows = sheet.getRange(2, 1, manifest.sheetChunks, 1).getValues();
    const encoded = rows.map(row => String(row[0] || '').startsWith('chunk:') ? String(row[0]).slice(6) : '').join('');
    const snapshot = decode(encoded);
    return snapshot ? Object.assign(snapshot, {storage: 'sheet'}) : null;
  } catch (error) {
    Logger.log('TASKHUB_COMPLETE_SNAPSHOT_READ_FAILED ' + String(error && error.message || error));
    return null;
  }
}

function prepareCompleteDisplaySnapshotWriteLocked_(spreadsheet, props, values, skipSchemaValidation) {
  const properties = props || PropertiesService.getUserProperties();
  const savedValues = values || properties.getProperties();
  const previous = getCompleteDisplayManifest_(Object.assign({}, savedValues, {[TEST_CASE_MODE_PROPERTY]: 'false'}));
  const slot = previous && previous.slot === 'a' ? 'b' : 'a';
  const sheet = getOrCreateDisplaySheetLocked_(spreadsheet, completeDisplaySnapshotSheetName_(slot),
    ['完成済み一覧（圧縮）'], skipSchemaValidation === true);
  return {props: properties, values: savedValues, slot, sheet,
    oldCount: Math.max(0, sheet.getLastRow() - 1)};
}

/** Caller holds the user lock; publishing the manifest is a separate final step. */
function stageCompleteDisplaySnapshotLocked_(spreadsheet, active, completed, notices, displayGeneration, statusGeneration, preparedWrite) {
  const prepared = preparedWrite || prepareCompleteDisplaySnapshotWriteLocked_(spreadsheet);
  const {props, values, slot, sheet, oldCount} = prepared;
  const id = String(Date.now()) + ':' + Utilities.getUuid();
  const bundle = {id,
    active: active.map(compactCompleteTaskListItem_),
    completed: completed.map(compactCompleteTaskListItem_),
    notices: notices.map(item => Object.assign(toUniversityNoticeListItemForWeb_(item), {
      originalMessageIdForState: String(item.originalMessageIdForState || '')
    }))};
  const json = JSON.stringify(bundle);
  const encoded = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes());
  if (encoded.length > COMPLETE_DISPLAY_MAX_ENCODED_LENGTH) throw new Error('表示一覧の保存容量を超えました。');
  const sheetRows = [];
  for (let start = 0; start < encoded.length; start += COMPLETE_DISPLAY_SHEET_CHUNK_LENGTH) {
    sheetRows.push(['chunk:' + encoded.slice(start, start + COMPLETE_DISPLAY_SHEET_CHUNK_LENGTH)]);
  }
  replaceDisplaySheetRows_(sheet, ['完成済み一覧（圧縮）'], sheetRows, oldCount);

  const prefix = COMPLETE_DISPLAY_CHUNK_PREFIX + slot + '_';
  const remainingBytes = Object.keys(values).reduce((total, key) => key.startsWith(prefix)
    ? total : total + key.length + (key.startsWith(COMPLETE_DISPLAY_CHUNK_PREFIX)
      ? String(values[key]).length : String(values[key]).length * 3), 0);
  let propertyChunks = 0;
  if (encoded.length <= COMPLETE_DISPLAY_PROPERTY_MAX_LENGTH &&
      remainingBytes + encoded.length + 2000 <= COMPLETE_DISPLAY_PROPERTY_STORE_BUDGET) {
    try {
      const chunks = {};
      for (let start = 0; start < encoded.length; start += COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH) {
        chunks[prefix + propertyChunks++] = encoded.slice(start, start + COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH);
      }
      if (typeof props.setProperties === 'function') props.setProperties(chunks);
      else Object.keys(chunks).forEach(key => props.setProperty(key, chunks[key]));
    } catch (error) {
      propertyChunks = 0;
      Logger.log('TASKHUB_COMPLETE_SNAPSHOT_PROPERTY_FALLBACK ' + String(error && error.message || error));
    }
  }
  Object.keys(values).filter(key => key.startsWith(prefix) &&
    Number(key.slice(prefix.length)) >= propertyChunks).forEach(key => props.deleteProperty(key));
  return {revision: COMPLETE_DISPLAY_SNAPSHOT_REVISION, displayRevision: NOTIFICATION_DISPLAY_DATA_REVISION,
    id, slot, spreadsheetId: spreadsheet.getId(), displayGeneration, statusGeneration,
    encodedLength: encoded.length, propertyChunks, sheetChunks: sheetRows.length,
    digest: completeDisplayDigest_(encoded), jsonLength: json.length,
    counts: {active: bundle.active.length, completed: bundle.completed.length, notices: bundle.notices.length}};
}

function publishCompleteDisplaySnapshotLocked_(manifest) {
  // A single pointer update publishes the whole generation. Interrupted writes
  // leave the previous pointer and all its chunks/sheet cells intact.
  PropertiesService.getUserProperties().setProperty(COMPLETE_DISPLAY_SNAPSHOT_PROPERTY, JSON.stringify(manifest));
  Logger.log('TASKHUB_COMPLETE_SNAPSHOT_COMMIT ' + JSON.stringify({
    slot: manifest.slot, counts: manifest.counts, encodedLength: manifest.encodedLength,
    propertyChunks: manifest.propertyChunks, jsonLength: manifest.jsonLength
  }));
}

function completeDisplayPayload_(snapshot, view, properties) {
  const {manifest, bundle} = snapshot;
  const noticeView = view === 'university';
  const completedView = view === 'completed' || view === '完了';
  if (!noticeView && manifest.statusGeneration !== String(properties[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0')) return null;
  const items = (noticeView ? bundle.notices : completedView ? bundle.completed : bundle.active)
    .map(item => Object.assign({}, item));
  if (noticeView) {
    const prefix = getUniversityNoticeStatePrefix_(false);
    items.forEach(item => {
      let state = {};
      try {state = JSON.parse(properties[prefix + item.messageId] ||
        (item.originalMessageIdForState && properties[prefix + item.originalMessageIdForState]) || '{}');} catch (_) {}
      item.read = Boolean(state.read); item.saved = Boolean(state.saved);
      delete item.originalMessageIdForState;
    });
  }
  return {items, partial: false, totalCount: items.length, committedSnapshot: true,
    dataGeneration: manifest.displayGeneration, snapshotId: manifest.id,
    cacheToken: noticeView ? 'snapshot:' + manifest.id : '',
    status: completedView ? '完了' : '未完了', testCaseClockState: getTestCaseClockStateForWeb(properties)};
}

function getCompleteDisplayPayloadForWeb_(view, properties, propertiesOnly) {
  const startedAt = Date.now();
  const snapshot = readCompleteDisplaySnapshot_(properties, propertiesOnly);
  const payload = snapshot ? completeDisplayPayload_(snapshot, view, properties) : null;
  if (payload) Logger.log('TASKHUB_COMPLETE_LIST_READ ' + JSON.stringify({
    view, storage: snapshot.storage, itemCount: payload.items.length, totalMs: Date.now() - startedAt,
    spreadsheetRead: snapshot.storage === 'sheet', cacheRead: false
  }));
  return payload;
}

function getCompleteInitialDisplayPayloadForWeb_(view, properties) {
  const startedAt = Date.now();
  const snapshot = readCompleteDisplaySnapshot_(properties, true);
  if (!snapshot) return null;
  const payload = completeDisplayPayload_(snapshot, view, properties);
  if (!payload) return null;
  const result = {view, payload};
  if (view === 'home') result.universityPayload = completeDisplayPayload_(snapshot, 'university', properties);
  // Completed tasks are stored in the same bundle but are not sent at Home
  // startup. Bound the actual HTML projection, not that larger stored bundle.
  const initialDataLength = serializeTaskHubInitialPayload_(result).length;
  if (initialDataLength > COMPLETE_DISPLAY_INITIAL_HTML_MAX_LENGTH) return null;
  Logger.log('TASKHUB_COMPLETE_INITIAL_PAYLOAD ' + JSON.stringify({
    view, taskCount: snapshot.manifest.counts.active, noticeCount: snapshot.manifest.counts.notices,
    jsonLength: snapshot.manifest.jsonLength, initialDataLength, totalMs: Date.now() - startedAt,
    spreadsheetRead: false, cacheRead: false
  }));
  return result;
}

function refreshCompleteSnapshotTaskStatusLocked_(spreadsheet, activeRows, completedRows, properties) {
  // Notice content is unchanged by a task completion. Reuse the committed list
  // instead of rereading/reclassifying notification source sheets.
  const snapshot = readCompleteDisplaySnapshot_(properties, false);
  if (!snapshot) return false;
  const manifest = stageCompleteDisplaySnapshotLocked_(spreadsheet,
    activeRows.map(taskDisplayRowToItem_), completedRows.map(taskDisplayRowToItem_),
    snapshot.bundle.notices, properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY],
    String(properties[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0'));
  SpreadsheetApp.flush();
  publishCompleteDisplaySnapshotLocked_(manifest);
  return true;
}

/** Explicit migration/measurement: prepare projections from saved rows, no Gmail/API. */
function taskhubPrepareCompleteDisplaySnapshotForMeasurement() {
  return runWithUserLock_('表示一覧の準備', () => rebuildNotificationDisplayDataLocked_(getSpreadsheetForRead_()));
}

function getTaskNotificationBodyForWeb(messageId, status, expectedGeneration) {
  const id = String(messageId || '');
  if (!id || id.length > 1000) return {found: false, messageId: id, body: ''};
  const properties = PropertiesService.getUserProperties().getProperties();
  if (properties[TEST_CASE_MODE_PROPERTY] === 'true') {
    const items = getNotificationsForWebLocked_(properties).concat(getCompletedNotificationsForWebLocked_(properties));
    const item = items.find(value => String(value.messageId) === id);
    return {found: Boolean(item), messageId: id, body: item ? String(item.body || '') : ''};
  }
  if (!isNotificationDisplayDataCurrent_(properties)) throw new Error('課題詳細を更新中です。少し待って再度開いてください。');
  if (expectedGeneration && expectedGeneration !== properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY]) {
    return {found: false, stale: true, messageId: id, body: ''};
  }
  const spreadsheet = getSpreadsheetForRead_(properties);
  const names = status === '完了' ? [COMPLETED_TASK_DISPLAY_SHEET_NAME, TASK_DISPLAY_SHEET_NAME]
    : [TASK_DISPLAY_SHEET_NAME, COMPLETED_TASK_DISPLAY_SHEET_NAME];
  for (const name of names) {
    const sheet = spreadsheet && spreadsheet.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const rowNumber = findTaskDisplayRowNumber_(sheet, id, TASK_DISPLAY_FIELDS.indexOf('messageId') + 1);
    if (rowNumber < 0) continue;
    const body = sheet.getRange(rowNumber, TASK_DISPLAY_FIELDS.indexOf('body') + 1, 1, 1).getValues()[0][0];
    const latest = PropertiesService.getUserProperties().getProperties();
    if (!isNotificationDisplayDataCurrent_(latest) ||
        properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] !== latest[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY]) {
      throw new Error('課題詳細を更新中です。少し待って再度開いてください。');
    }
    return {found: true, messageId: id, body: String(body || '')};
  }
  return {found: false, messageId: id, body: ''};
}
