// Plan all Sheet reads before starting writes. Extension saves can reuse
// initialized storage and leave identical prepared views untouched.
const DISPLAY_WRITE_FINGERPRINTS_PROPERTY = 'TASKHUB_DISPLAY_WRITE_FINGERPRINTS';

function getNotificationStorageForExtensionLocked_(spreadsheet, inCampusSheet) {
  const properties = PropertiesService.getUserProperties().getProperties();
  const sheetsBySource = {
    'Google Classroom': spreadsheet.getSheetByName(CONFIG.SUPPLEMENTARY_SHEET_NAME),
    inCampus: inCampusSheet
  };
  const storageReady = isUserStorageInitializationCurrentForProperties_(properties) &&
    isNotificationDisplayDataCurrentForProperties_(properties) &&
    !shouldValidateNotificationDisplaySheets_(spreadsheet) &&
    sheetsBySource['Google Classroom'] && inCampusSheet &&
    [CONFIG.CLASSROOM_COURSES_SHEET_NAME, CONFIG.CLASSROOM_COURSEWORK_SHEET_NAME,
      CONFIG.CLASSROOM_SUBMISSIONS_SHEET_NAME].every(name => spreadsheet.getSheetByName(name));
  return {
    reused: Boolean(storageReady),
    sheetsBySource: storageReady ? sheetsBySource
      : ensureNotificationStorageLocked_(spreadsheet, {inCampusSheet})
  };
}

function prepareDisplaySheetWritePlans_(spreadsheet, views, properties, validateSchemas, reuseUnchanged, forceWriteNames) {
  let previous = null;
  try { previous = JSON.parse(properties[DISPLAY_WRITE_FINGERPRINTS_PROPERTY] || 'null'); } catch (_) {}
  const statusGeneration = String(properties[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0');
  const canReuse = reuseUnchanged === true && !validateSchemas &&
    isNotificationDisplayDataCurrentForProperties_(properties) && previous &&
    previous.spreadsheetId === spreadsheet.getId() &&
    previous.revision === NOTIFICATION_DISPLAY_DATA_REVISION &&
    previous.statusGeneration === statusGeneration;
  const forced = new Set(forceWriteNames || []);
  const fingerprints = {};
  const plans = views.map(view => {
    const sheet = getOrCreateDisplaySheetLocked_(spreadsheet, view.name, view.headers, !validateSchemas);
    const oldCount = Math.max(0, sheet.getLastRow() - 1);
    const digest = completeDisplayDigest_(JSON.stringify(toNotificationWebSafeValue_(view.rows)));
    fingerprints[view.name] = {digest, count: view.rows.length};
    const saved = canReuse && previous.views && previous.views[view.name];
    const unchanged = Boolean(saved && !forced.has(view.name) &&
      saved.digest === digest && saved.count === view.rows.length && oldCount === view.rows.length);
    return Object.assign({}, view, {sheet, oldCount, unchanged});
  });
  return {plans, fingerprints: {spreadsheetId: spreadsheet.getId(),
    revision: NOTIFICATION_DISPLAY_DATA_REVISION, statusGeneration, views: fingerprints}};
}

/** Measure the changed-task display write path without changing any source data. */
function taskhubMeasureInCampusDisplayRefresh() {
  return runWithUserLock_('inCampus表示更新の計測', () => {
    const startedAt = Date.now();
    const spreadsheet = getOrCreateSpreadsheetLocked_();
    const inCampusSheet = getOrCreateInCampusUnifiedSheetLocked_(spreadsheet);
    const sourceRows = inCampusSheet.getDataRange().getValues().slice(1);
    const storage = getNotificationStorageForExtensionLocked_(spreadsheet, inCampusSheet);
    const preparationMs = Date.now() - startedAt;
    const displayStartedAt = Date.now();
    const result = rebuildNotificationDisplayDataLocked_(spreadsheet, {
      sheetsBySource: storage.sheetsBySource,
      preloadedRowsBySource: {inCampus: sourceRows},
      reuseUnchangedDisplaySheets: true,
      reuseClassroomDisplayInputs: true,
      // An identical task projection is deliberately rewritten to measure the
      // same publication path as a changed task. Gmail/API/source rows stay intact.
      forceWriteDisplaySheetNames: [TASK_DISPLAY_SHEET_NAME]
    });
    Logger.log('TASKHUB_INCAMPUS_DISPLAY_MEASUREMENT ' + JSON.stringify({
      preparationMs, displayBuildMs: Date.now() - displayStartedAt,
      totalMs: Date.now() - startedAt, storageReused: storage.reused,
      sourceDataChanged: false, forcedTaskDisplayWrite: true, ...result
    }));
    return result;
  });
}
