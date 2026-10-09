function doPost(e) {
  const requestStartedAt = Date.now();
  try {
    return runWithUserLock_('同期処理', () => {
    const lockAcquiredAt = Date.now();
    const payload = parseJsonBody_(e);
    assertValidApiToken_(payload);

    if (payload.action === 'upsertInCampusAssignment') {
      const assignment = sanitizeObjectByFieldLimits_(payload.assignment || {}, ASSIGNMENT_FIELD_LIMITS);
      validateAssignment_(assignment);

      const spreadsheet = getOrCreateSpreadsheetLocked_();
      const inCampusUnifiedSheet = getOrCreateInCampusUnifiedSheetLocked_(spreadsheet);
      const inCampusExtractSheet = createInCampusExtractSheetAdapter_(inCampusUnifiedSheet);
      const batchResult = upsertInCampusAssignmentsLocked_([assignment], spreadsheet, inCampusExtractSheet);
      const result = batchResult.results[0];
      if (result.changed) {
        const storage = getNotificationStorageForExtensionLocked_(spreadsheet, inCampusUnifiedSheet);
        refreshNotificationDisplayDataAfterSyncLocked_(spreadsheet, 'extension-incampus-upsert', {
          sheetsBySource: storage.sheetsBySource,
          preloadedRowsBySource: {inCampus: inCampusExtractSheet.getUnifiedRowsSnapshot().slice(1)},
          reuseUnchangedDisplaySheets: true,
          reuseClassroomDisplayInputs: true
        });
      }

      return jsonResponse_({
        ok: true,
        updated: result.updated,
        unchanged: Boolean(result.unchanged),
        row: result.row
      });
    }

    if (payload.action === 'upsertInCampusAssignments') {
      const assignments = sanitizeAssignmentRecords_(payload.assignments || []);
      assignments.forEach(validateAssignment_);

      if (assignments.length === 0) {
        return jsonResponse_({ok: true, foundCount: 0, newCount: 0, updatedCount: 0, unchangedCount: 0, results: []});
      }

      const spreadsheetStartedAt = Date.now();
      const spreadsheet = getOrCreateSpreadsheetLocked_();
      const spreadsheetSetupMs = Date.now() - spreadsheetStartedAt;
      const inCampusSheetStartedAt = Date.now();
      const inCampusUnifiedSheet = getOrCreateInCampusUnifiedSheetLocked_(spreadsheet);
      const inCampusExtractSheet = createInCampusExtractSheetAdapter_(inCampusUnifiedSheet);
      const inCampusSheetSetupMs = Date.now() - inCampusSheetStartedAt;
      const upsertStartedAt = Date.now();
      const result = upsertInCampusAssignmentsLocked_(assignments, spreadsheet, inCampusExtractSheet);
      const upsertMs = Date.now() - upsertStartedAt;
      let storageSetupMs = 0;
      let displayBuildMs = 0;
      let storageReused = false;
      if (result.changedCount > 0) {
        const storageSetupStartedAt = Date.now();
        const storage = getNotificationStorageForExtensionLocked_(spreadsheet, inCampusUnifiedSheet);
        const sheetsBySource = storage.sheetsBySource;
        storageReused = storage.reused;
        storageSetupMs = Date.now() - storageSetupStartedAt;
        const preloadedInCampusRows = inCampusExtractSheet.getUnifiedRowsSnapshot().slice(1);
        const displayBuildStartedAt = Date.now();
        refreshNotificationDisplayDataAfterSyncLocked_(spreadsheet, 'extension-incampus-batch-upsert', {
          sheetsBySource,
          preloadedRowsBySource: {inCampus: preloadedInCampusRows},
          reuseUnchangedDisplaySheets: true,
          reuseClassroomDisplayInputs: true
        });
        displayBuildMs = Date.now() - displayBuildStartedAt;
      }
      Logger.log('TASKHUB_INCAMPUS_BATCH_SYNC ' + JSON.stringify({
        lockWaitMs: lockAcquiredAt - requestStartedAt,
        spreadsheetSetupMs,
        inCampusSheetSetupMs,
        upsertMs,
        storageSetupMs,
        storageReused,
        displayBuildMs,
        totalBeforeResponseMs: Date.now() - requestStartedAt,
        assignmentCount: assignments.length,
        changedCount: result.changedCount,
        unchangedCount: result.unchangedCount
      }));

      return jsonResponse_({
        ok: true,
        foundCount: result.results.length,
        newCount: result.results.filter(item => !item.updated).length,
        updatedCount: result.results.filter(item => item.updated && !item.unchanged).length,
        unchangedCount: result.unchangedCount,
        results: result.results.map(item => ({
          updated: item.updated,
          unchanged: Boolean(item.unchanged),
          row: item.row
        }))
      });
    }

    if (payload.action === 'completeClassroomAssignments') {
      const result = completeClassroomAssignments_(sanitizePostRecords_(payload.records || []));
      refreshNotificationDisplayDataAfterSyncLocked_(getOrCreateSpreadsheetLocked_(), 'extension-classroom-completion');

      return jsonResponse_({
        ok: true,
        foundCount: result.foundCount,
        matchedCount: result.matchedCount,
        createdCount: result.createdCount,
        unmatchedCount: result.unmatchedCount,
        results: result.results
      });
    }

    if (payload.action === 'updateClassroomDueTimes') {
      const result = updateClassroomDueTimes_(sanitizePostRecords_(payload.records || []));
      refreshNotificationDisplayDataAfterSyncLocked_(getOrCreateSpreadsheetLocked_(), 'extension-classroom-due-time');

      return jsonResponse_({
        ok: true,
        foundCount: result.foundCount,
        matchedCount: result.matchedCount,
        createdCount: result.createdCount,
        unmatchedCount: result.unmatchedCount,
        dueTimeCount: result.dueTimeCount,
        results: result.results
      });
    }

    throw new Error('未対応のactionです: ' + payload.action);
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function parseJsonBody_(e) {
  const body = e && e.postData && e.postData.contents;

  if (!body) {
    throw new Error('POST本文が空です。');
  }

  if (String(body).length > MAX_POST_BODY_LENGTH) {
    throw new Error('POST本文が大きすぎます。');
  }

  return JSON.parse(body);
}

function getSecuritySettingsForWeb() {
  const apiToken = getSavedApiToken_();
  const hasApiToken = isValidApiToken_(apiToken);

  return {
    postAuthRequired: true,
    hasApiToken,
    ...getTestCaseSettings_()
  };
}

function getTestCaseSettings_() {
  let ready = false;
  let message = '';
  try {
    openTestCaseSpreadsheet_();
    ready = true;
  } catch (error) {
    message = String(error && error.message ? error.message : error);
  }
  return {
    testSpreadsheetConfigured: Boolean(getConfiguredTestSpreadsheetId_()),
    testSpreadsheetReady: ready,
    testSpreadsheetMessage: message,
    ...getTestCaseClockStateForWeb()
  };
}

function getTestCaseClockStateForWeb(userProperties) {
  const properties = userProperties || PropertiesService.getUserProperties().getProperties();
  const clock = getTestCaseClockFromProperties_(properties);
  return {
    testCaseModeEnabled: properties[TEST_CASE_MODE_PROPERTY] === 'true',
    testCaseClockDateTime: clock ? Utilities.formatDate(clock, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm") : '',
    testCaseClockPresets: TEST_CASE_CLOCK_PRESETS.map(preset => ({...preset}))
  };
}

function getTestCaseClockFromProperties_(properties) {
  const saved = (properties || {})[TEST_CASE_CLOCK_PROPERTY];
  if (!saved) return null;
  const date = new Date(saved);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTestCaseReferenceNowFromProperties_(properties) {
  return getTestCaseClockFromProperties_(properties) || new Date();
}

function setTestCaseClockForWeb(dateTime) {
  if (typeof dateTime !== 'string') throw new Error('日時は選択肢または日時入力から指定してください。');
  const value = dateTime.trim();
  runWithUserLock_('テスト判定日時設定', () => {
    const props = PropertiesService.getUserProperties();
    if (!value) {
      props.deleteProperty(TEST_CASE_CLOCK_PROPERTY);
      return;
    }
    const parsed = parseTestCaseClockDateTime_(value);
    if (!parsed) throw new Error('日時が正しくありません。日本時間の実在する日付と時刻を指定してください。');
    props.setProperty(TEST_CASE_CLOCK_PROPERTY, parsed.toISOString());
  });
  return getTestCaseClockStateForWeb();
}

function parseTestCaseClockDateTime_(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (year < 2000 || year > 2099 || !isValidDateParts_(year, month, day) || hour > 23 || minute > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
}

function getTestCaseClock_() {
  const saved = PropertiesService.getUserProperties().getProperty(TEST_CASE_CLOCK_PROPERTY);
  if (!saved) return null;
  const date = new Date(saved);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTestCaseReferenceNow_() {
  return getTestCaseClock_() || new Date();
}

function getTestCaseClockDateTime_() {
  const date = getTestCaseClock_();
  return date ? Utilities.formatDate(date, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm") : '';
}

function setTestCaseModeForWeb(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('テストケース設定にはONまたはOFFを指定してください。');
  runWithUserLock_('テストケース設定', () => {
    const props = PropertiesService.getUserProperties();
    if (enabled) {
      openTestCaseSpreadsheet_();
      if (!isTestCaseModeEnabled_()) {
        clearTestNotificationStates_();
        props.setProperty(TEST_CASE_SESSION_STARTED_AT_PROPERTY, new Date().toISOString());
      }
      props.setProperty(TEST_CASE_MODE_PROPERTY, 'true');
    } else {
      props.deleteProperty(TEST_CASE_MODE_PROPERTY);
      props.deleteProperty(TEST_CASE_SESSION_STARTED_AT_PROPERTY);
    }
  });
  return getSecuritySettingsForWeb();
}

function rotateApiTokenForWeb() {
  const apiToken = generateApiToken_();
  PropertiesService.getUserProperties().setProperty(API_TOKEN_PROPERTY, apiToken);

  return {
    postAuthRequired: true,
    hasApiToken: true,
    apiToken,
    tokenReturnedOnce: true,
    ...getTestCaseSettings_()
  };
}

function assertValidApiToken_(payload) {
  const expectedToken = getSavedApiToken_();
  const providedToken = getProvidedApiToken_(payload);

  if (!isValidApiToken_(expectedToken)) {
    throw new Error('APIトークンが未発行です。セキュリティ設定でトークンを再発行し、拡張機能へ設定してください。');
  }

  if (!providedToken || !constantTimeEquals_(providedToken, expectedToken)) {
    throw new Error('認証に失敗しました。セキュリティ設定のAPIトークンを送信してください。');
  }
}

function getProvidedApiToken_(payload) {
  return String(
    payload.apiToken ||
    payload.securityToken ||
    payload.token ||
    ''
  ).trim();
}

function getSavedApiToken_() {
  const props = PropertiesService.getUserProperties();

  return String(props.getProperty(API_TOKEN_PROPERTY) || '').trim();
}

function generateApiToken_() {
  return [
    Utilities.getUuid(),
    Utilities.getUuid()
  ].join('').replace(/-/g, '');
}

function isValidApiToken_(token) {
  return /^[A-Za-z0-9_-]+$/.test(String(token || '')) &&
    String(token || '').length >= API_TOKEN_MIN_LENGTH;
}

function constantTimeEquals_(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  const maxLength = Math.max(leftText.length, rightText.length);
  let diff = leftText.length === rightText.length ? 0 : 1;

  for (let i = 0; i < maxLength; i++) {
    const leftCode = i < leftText.length ? leftText.charCodeAt(i) : 0;
    const rightCode = i < rightText.length ? rightText.charCodeAt(i) : 0;
    diff |= leftCode ^ rightCode;
  }

  return diff === 0;
}

function sanitizePostRecords_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  if (records.length > MAX_POST_RECORDS) {
    throw new Error('一度に送信できるrecordsが多すぎます。');
  }

  return records.map(record => sanitizeObjectByFieldLimits_(record || {}, CLASSROOM_RECORD_FIELD_LIMITS));
}

function sanitizeAssignmentRecords_(assignments) {
  if (!Array.isArray(assignments)) {
    throw new Error('assignmentsが配列ではありません。');
  }

  if (assignments.length > MAX_POST_RECORDS) {
    throw new Error('一度に送信できる課題データが多すぎます。');
  }

  return assignments.map(assignment => {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      throw new Error('課題データの形式が正しくありません。');
    }
    return sanitizeObjectByFieldLimits_(assignment, ASSIGNMENT_FIELD_LIMITS);
  });
}

function sanitizeObjectByFieldLimits_(source, fieldLimits) {
  const sanitized = {};

  Object.keys(fieldLimits).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      return;
    }

    sanitized[key] = limitText_(source[key], fieldLimits[key]);
  });

  return sanitized;
}

function limitText_(value, maxLength) {
  if (value instanceof Date) {
    return value;
  }

  const text = typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : String(value || '');

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
}

function toSafeSpreadsheetRow_(rowValues) {
  return rowValues.map(value => toSafeSpreadsheetCell_(value));
}

function toSafeSpreadsheetCell_(value) {
  if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/^[\t\r\n ]*[=+\-@]/.test(text)) {
    return "'" + text;
  }

  return text;
}

function isAllowedInCampusUrlForStorage_(value) {
  const hostPattern = ALLOWED_INCAMPUS_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    '^https://' + hostPattern + '(?::443)?(?:[/?#]|$)[^\\s<>"\'\\\\]*$',
    'i'
  );

  return pattern.test(String(value || '').trim());
}
