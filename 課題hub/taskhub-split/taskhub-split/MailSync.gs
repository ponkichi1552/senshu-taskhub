function saveClassroomMailsToSheet() {
  // Collect Gmail data outside the shared sheet lock, then re-check message
  // IDs before committing. A long Gmail scan must never hold the user lock.
  if (userStorageLockDepth_ > 0) {
    throw new Error('Gmail同期中に保存ロックを保持できません。');
  }

  const scanStartedAt = new Date();
  const scanContext = runWithUserLock_('メール取込準備処理', () => {
    const ss = getOrCreateSpreadsheetLocked_();
    const sheetsBySource = ensureNotificationStorageLocked_(ss);
    const userProperties = PropertiesService.getUserProperties();
    const initialBackfillPending = userProperties.getProperty(NOTIFICATION_INITIAL_BACKFILL_PENDING_PROPERTY) === 'true';
    const savedMessageIdsBySource = {};
    const latestReceivedAtBySource = {};
    let latestWorkbookReceivedAt = null;

    NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
      const savedState = getSavedNotificationState_(sheetsBySource[storageConfig.source]);
      savedMessageIdsBySource[storageConfig.source] = Array.from(savedState.messageIds);
      latestReceivedAtBySource[storageConfig.source] = savedState.latestReceivedAt;
      if (savedState.latestReceivedAt && (!latestWorkbookReceivedAt || savedState.latestReceivedAt > latestWorkbookReceivedAt)) {
        latestWorkbookReceivedAt = savedState.latestReceivedAt;
      }
    });

    const lastSuccessfulSyncAt = parseNotificationReceivedDate_(
      userProperties.getProperty(NOTIFICATION_LAST_SUCCESSFUL_SYNC_PROPERTY)
    );
    const fallbackWatermark = [latestWorkbookReceivedAt, lastSuccessfulSyncAt]
      .filter(value => value instanceof Date)
      .reduce((latest, value) => !latest || value > latest ? value : latest, null);
    if (!initialBackfillPending && !fallbackWatermark) {
      return {
        spreadsheetId: ss.getId(),
        skipped: true,
        reason: '既存の保存Excelに有効な受信日時と前回同期日時がなく、初回20日照合フラグもありません。広範囲検索はせず同期を見送りました。'
      };
    }

    return {
      spreadsheetId: ss.getId(),
      retentionCutoff: getNotificationRetentionCutoff_(new Date()),
      savedMessageIdsBySource,
      latestReceivedAtBySource: Object.fromEntries(NOTIFICATION_STORAGE_CONFIGS.map(storageConfig => [
        storageConfig.source,
        [latestReceivedAtBySource[storageConfig.source], fallbackWatermark]
          .filter(value => value instanceof Date)
          .reduce((latest, value) => !latest || value > latest ? value : latest, null)
      ])),
      initialBackfillPending,
      scanStartedAt: scanStartedAt.toISOString()
    };
  });

  if (scanContext.skipped) {
    return {
      skipped: true,
      reason: scanContext.reason,
      savedCount: 0,
      classroomSavedCount: 0,
      inCampusSavedCount: 0,
      autoCompletedCount: 0,
      spreadsheetId: scanContext.spreadsheetId
    };
  }

  const newRowsBySource = {};
  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const searchQuery = getNotificationSearchQuery_(
      storageConfig,
      scanContext.latestReceivedAtBySource[storageConfig.source],
      scanContext.initialBackfillPending
    );
    newRowsBySource[storageConfig.source] = collectNewNotificationRows_(
      storageConfig,
      new Set(scanContext.savedMessageIdsBySource[storageConfig.source] || []),
      scanContext.retentionCutoff,
      searchQuery,
      scanContext.initialBackfillPending ? null : scanContext.latestReceivedAtBySource[storageConfig.source]
    );
  });

  return runWithUserLock_('メール保存処理', () => {
    const ss = getOrCreateSpreadsheetLocked_();
    if (ss.getId() !== scanContext.spreadsheetId) {
      Logger.log('保存先の設定が取込中に切り替わったため、通知の保存を中止しました。');
      return {
        skipped: true,
        reason: '保存先の設定が取込中に切り替わったため、通知の保存を中止しました。',
        savedCount: 0,
        classroomSavedCount: 0,
        inCampusSavedCount: 0,
        autoCompletedCount: 0
      };
    }
    const sheetsBySource = ensureNotificationStorageLocked_(ss);
    const savedCountsBySource = {};
    let savedCount = 0;

    NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
      const sheet = sheetsBySource[storageConfig.source];
      const savedMessageIds = getSavedMessageIds_(sheet);
      const newRows = (newRowsBySource[storageConfig.source] || []).filter(row => {
        const messageId = String(row[1] || '').trim();
        if (!messageId || savedMessageIds.has(messageId)) return false;
        savedMessageIds.add(messageId);
        return true;
      });

      appendNotificationRows_(sheet, newRows);
      normalizeNotificationSheet_(sheet, storageConfig);
      savedCountsBySource[storageConfig.source] = newRows.length;
      savedCount += newRows.length;
    });

    const autoCompletedCount = applySavedInCampusSubmissionRecordsLocked_(sheetsBySource.inCampus);
    SpreadsheetApp.flush();
    const userProperties = PropertiesService.getUserProperties();
    userProperties.deleteProperty(NOTIFICATION_INITIAL_BACKFILL_PENDING_PROPERTY);
    // Use the start time as the next lower bound so mail arriving during this
    // scan remains eligible on the next run.
    userProperties.setProperty(NOTIFICATION_LAST_SUCCESSFUL_SYNC_PROPERTY, scanContext.scanStartedAt);
    Logger.log('保存件数: ' + savedCount);
    Logger.log('inCampus提出記録による自動完了件数: ' + autoCompletedCount);
    Logger.log('スプレッドシートURL: ' + ss.getUrl());

    return {
      savedCount,
      classroomSavedCount: savedCountsBySource['Google Classroom'] || 0,
      inCampusSavedCount: savedCountsBySource.inCampus || 0,
      autoCompletedCount,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl()
    };
  });
}

function getNotificationSearchQuery_(storageConfig, latestReceivedAt, initialBackfillPending) {
  if (initialBackfillPending) return storageConfig.initialQuery || storageConfig.query;
  if (!latestReceivedAt) return '';

  // Gmail's after: operator accepts dates rather than timestamps. Include the
  // latest saved day, then filter exact received times and deduplicate IDs.
  const afterDate = Utilities.formatDate(latestReceivedAt, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  return storageConfig.query + ' after:' + afterDate;
}

function collectNewNotificationRows_(storageConfig, savedMessageIds, retentionCutoff, searchQuery, latestReceivedAt) {
  const newRows = [];
  const query = searchQuery || storageConfig.query;
  if (!query) return newRows;

  for (let offset = 0; ; offset += storageConfig.batchSize) {
    const threads = GmailApp.search(query, offset, storageConfig.batchSize);
    threads.forEach(thread => {
      const messages = thread.getMessages();
      if (!messages || messages.length === 0) return;

      const gmailLink = thread.getPermalink();
      messages.forEach(message => {
        const messageId = String(message.getId() || '');
        if (!messageId || savedMessageIds.has(messageId)) return;

        const from = message.getFrom();
        const source = detectSource_(from);
        if (source !== storageConfig.source) return;

        const receivedDate = message.getDate();
        if (!receivedDate || receivedDate.getTime() <= retentionCutoff.getTime()) return;
        if (latestReceivedAt && receivedDate.getTime() < latestReceivedAt.getTime()) return;

        const subject = message.getSubject();
        const body = message.getPlainBody() || '';
        const extracted = extractNotificationInfo_(source, subject, body, receivedDate);
        newRows.push(toSafeSpreadsheetRow_([
          new Date(),
          messageId,
          source,
          extracted.courseName,
          extracted.title,
          extracted.dueDate,
          extracted.dueStatus,
          subject,
          from,
          receivedDate,
          gmailLink,
          body.slice(0, CONFIG.BODY_LIMIT),
          '未確認',
          ''
        ]));
        savedMessageIds.add(messageId);
      });
    });

    if (threads.length < storageConfig.batchSize) break;
  }

  return newRows;
}

function runWithUserLock_(label, callback) {
  if (userStorageLockDepth_ > 0) return callback();
  const lock = LockService.getUserLock();
  let hasLock = false;
  try {
    if (!lock.tryLock(5000)) {
      throw new Error((label || '処理') + 'が混み合っています。少し待ってから再実行してください。');
    }
    hasLock = true;
    userStorageLockDepth_++;
    return callback();
  } finally {
    if (hasLock) {
      try { SpreadsheetApp.flush(); }
      finally { userStorageLockDepth_--; lock.releaseLock(); }
    }
  }
}

function saveClassroomMailsToSheetLocked_() {
  throw new Error('Gmail同期は共有ロックの外側から実行してください。');
}

function getOrCreateSpreadsheet_() {
  return runWithUserLock_('保存データ処理', () => getOrCreateSpreadsheetLocked_());
}

function getOrCreateSpreadsheetLocked_() {
  const configuredId = getConfiguredSpreadsheetId_();

  if (configuredId) {
    return SpreadsheetApp.openById(configuredId);
  }

  const props = PropertiesService.getUserProperties();
  const savedId = props.getProperty(USER_SPREADSHEET_ID_PROPERTY) ||
    props.getProperty(LEGACY_SPREADSHEET_ID_PROPERTY);

  if (savedId) {
    try {
      const ss = SpreadsheetApp.openById(savedId);
      props.setProperty(USER_SPREADSHEET_ID_PROPERTY, ss.getId());

      return ss;
    } catch (error) {
      props.deleteProperty(USER_SPREADSHEET_ID_PROPERTY);
      props.deleteProperty(LEGACY_SPREADSHEET_ID_PROPERTY);
      Logger.log('保存済みスプレッドシートを開けなかったため再作成します: ' + error.message);
    }
  }

  const ss = SpreadsheetApp.create('課題通知Hub_保存データ');
  props.setProperty(USER_SPREADSHEET_ID_PROPERTY, ss.getId());
  props.setProperty(NOTIFICATION_INITIAL_BACKFILL_PENDING_PROPERTY, 'true');

  return ss;
}

function isTestCaseModeEnabled_() {
  return PropertiesService.getUserProperties().getProperty(TEST_CASE_MODE_PROPERTY) === 'true';
}

function openTestCaseSpreadsheet_() {
  const id = getConfiguredTestSpreadsheetId_();
  if (!id) throw new Error('テストケース用スプレッドシートが未設定です。管理者に設定を依頼してください。');

  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (error) {
    throw new Error('テストケース用スプレッドシートをこのGoogleアカウントで開けません。共有設定とログイン中のアカウントを確認してください。');
  }

  const requiredSheets = [
    {name: 'テストClassroom', headers: TEST_CASE_NOTIFICATION_HEADERS},
    {name: 'テストinCampus', headers: TEST_CASE_NOTIFICATION_HEADERS},
    {name: 'テスト抽出', headers: TEST_CASE_EXTRACT_HEADERS}
  ];
  if (!ss.getSheetByName(TEST_CASE_SETTINGS_SHEET_NAME)) {
    throw new Error('テストケース用スプレッドシートに「テスト設定」シートがありません。');
  }
  requiredSheets.forEach(spec => {
    const sheet = ss.getSheetByName(spec.name);
    if (!sheet) throw new Error('テストケース用スプレッドシートの構成が不正です。必要なシート: ' + spec.name);
    const actual = sheet.getRange(1, 1, 1, spec.headers.length).getValues()[0].map(value => String(value || '').trim());
    if (actual.join('\u001f') !== spec.headers.join('\u001f')) {
      throw new Error('テストケース用スプレッドシートの見出しが一致しません: ' + spec.name);
    }
  });
  return ss;
}

function getConfiguredTestSpreadsheetId_() {
  const configuredId = PropertiesService.getScriptProperties().getProperty(TEST_SPREADSHEET_ID_PROPERTY);
  return String(configuredId || DEFAULT_TEST_SPREADSHEET_ID || '').trim();
}

function getNotificationReadSheets_(testSpreadsheet, spreadsheet) {
  if (isTestCaseModeEnabled_()) {
    const ss = testSpreadsheet || spreadsheet || openTestCaseSpreadsheet_();
    return {
      'Google Classroom': ss.getSheetByName('テストClassroom'),
      inCampus: ss.getSheetByName('テストinCampus')
    };
  }
  let ss = spreadsheet;
  if (!ss) {
    ensureUserStorageForWeb_();
    ss = getOrCreateSpreadsheet_();
  }
  return {
    'Google Classroom': ss.getSheetByName(CONFIG.SUPPLEMENTARY_SHEET_NAME),
    inCampus: ss.getSheetByName(INCAMPUS_SHEET_NAME)
  };
}

function createNotificationReadContext_(testSpreadsheet, testMode) {
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  if (!useTestMode) ensureUserStorageForWeb_();
  const spreadsheet = useTestMode
    ? (testSpreadsheet || openTestCaseSpreadsheet_())
    : getOrCreateSpreadsheet_();
  return {
    testMode: useTestMode,
    spreadsheet,
    sheetsBySource: getNotificationReadSheets_(useTestMode ? spreadsheet : null, spreadsheet),
    sourceRowsBySource: Object.create(null),
    sheetReadMs: Object.create(null),
    sheetRowCounts: Object.create(null)
  };
}

function getInCampusReadSheet_(testSpreadsheet) {
  if (isTestCaseModeEnabled_()) return (testSpreadsheet || openTestCaseSpreadsheet_()).getSheetByName('テスト抽出');
  return getOrCreateInCampusSheet_();
}

function mapTestCaseNotificationRowForRead_(row, referenceDate) {
  const dateContext = getTestCaseDateContextForRead_(referenceDate);
  const mapped = normalizeNotificationRowWidth_(row);
  mapped[0] = new Date(dateContext.readAt);
  mapped[9] = new Date(dateContext.readAt);
  mapped[5] = shiftTestCaseDeadlineForRead_(row[5], dateContext);
  return mapped;
}

function mapTestCaseExtractRowForRead_(row, referenceDate) {
  const dateContext = getTestCaseDateContextForRead_(referenceDate);
  const mapped = row.slice();
  mapped[5] = shiftTestCaseDeadlineForRead_(row[5], dateContext);
  mapped[12] = new Date(dateContext.readAt);
  return mapped;
}

function getTestCaseDateContextForRead_(referenceDate) {
  if (referenceDate && typeof referenceDate === 'object' && Number.isInteger(referenceDate.deadlineDayOffset)) {
    return referenceDate;
  }
  return getTestCaseDateContext_(null, referenceDate instanceof Date ? referenceDate : null);
}

function getTestCaseDateContext_(testSpreadsheet, referenceDate, readAt) {
  const ss = testSpreadsheet || openTestCaseSpreadsheet_();
  const settings = ss.getSheetByName(TEST_CASE_SETTINGS_SHEET_NAME);
  if (!settings) throw new Error('テストケース用スプレッドシートに「テスト設定」シートがありません。');

  const settingValues = settings.getRange(3, 2, 2, 1).getValues();
  const position = String(settingValues[0][0] || '').trim();
  const baseDate = toTestCaseDateValue_(settingValues[1][0]);
  if (!['期限切れ', '今日まで', '明日まで', '今週中', '来週以降'].includes(position)) {
    throw new Error('テスト設定のB3は期限切れ、今日まで、明日まで、今週中、来週以降のいずれかにしてください。');
  }
  if (!baseDate) throw new Error('テスト設定のB4に有効な基準期限を入力してください。');

  const testReferenceDate = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? new Date(referenceDate)
    : getTestCaseReferenceNow_();
  const savedStart = new Date(PropertiesService.getUserProperties().getProperty(TEST_CASE_SESSION_STARTED_AT_PROPERTY) || '');
  const sessionStartedAt = !Number.isNaN(savedStart.getTime()) ? savedStart : new Date();
  const todayDayNumber = getTestCaseCalendarDayNumber_(testReferenceDate);
  const baseDayNumber = getTestCaseCalendarDayNumber_(baseDate);
  const utcToday = new Date(todayDayNumber * 86400000);
  const daysUntilSunday = (7 - utcToday.getUTCDay()) % 7;
  let targetDayNumber = todayDayNumber;
  if (position === '期限切れ') targetDayNumber--;
  else if (position === '明日まで') targetDayNumber++;
  else if (position === '今週中') targetDayNumber += daysUntilSunday;
  else if (position === '来週以降') targetDayNumber += daysUntilSunday + 7;

  return {
    referenceDate: testReferenceDate,
    readAt: readAt instanceof Date && !Number.isNaN(readAt.getTime()) ? new Date(readAt) : sessionStartedAt,
    position,
    deadlineDayOffset: targetDayNumber - baseDayNumber
  };
}

function toTestCaseDateValue_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value);
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 100000) {
    // Google/Excel serials represent wall-clock time in the sheet timezone.
    // The test workbook is pinned to Japan Standard Time (UTC+9).
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000) - 9 * 60 * 60 * 1000);
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = Number(match[4] || 0), minute = Number(match[5] || 0), second = Number(match[6] || 0);
    if (!isValidDateParts_(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second));
  }
  return null;
}

function getTestCaseCalendarDayNumber_(value) {
  const date = toTestCaseDateValue_(value);
  if (!date) return NaN;
  const [year, month, day] = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd').split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function shiftTestCaseDeadlineForRead_(value, dateContext) {
  const date = toTestCaseDateValue_(value);
  if (!date || !dateContext || !Number.isInteger(dateContext.deadlineDayOffset)) return value;
  return new Date(date.getTime() + dateContext.deadlineDayOffset * 86400000);
}

function getConfiguredSpreadsheetId_() {
  if (typeof DEFAULT_SPREADSHEET_ID !== 'undefined' && DEFAULT_SPREADSHEET_ID) {
    return String(DEFAULT_SPREADSHEET_ID).trim();
  }

  return '';
}

function getNotificationStorageConfigForSource_(source) {
  return NOTIFICATION_STORAGE_CONFIGS.find(config => config.source === source) || null;
}

function getOrCreateNotificationSheet_(ss, source) {
  const storageConfig = getNotificationStorageConfigForSource_(source);

  if (!storageConfig) {
    throw new Error('通知元に対応する保存先がありません: ' + source);
  }

  let sheet = ss.getSheetByName(storageConfig.sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(storageConfig.sheetName);
  }

  if (source === 'inCampus') {
    sheet = getOrCreateInCampusUnifiedSheetLocked_(ss);
  } else {
    setupHeader_(sheet);
  }
  return sheet;
}

function ensureNotificationStorage_(ss) {
  return runWithUserLock_('保存データ処理', () => ensureNotificationStorageLocked_(ss));
}

function ensureNotificationStorageLocked_(ss) {
  const spreadsheet = ss || getOrCreateSpreadsheet_();
  ensureClassroomStructuredStorageLocked_(spreadsheet);
  const sheetsBySource = {};

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    sheetsBySource[storageConfig.source] = getOrCreateNotificationSheet_(spreadsheet, storageConfig.source);
  });

  migrateLegacyNotificationSheet_(spreadsheet, sheetsBySource);
  migrateLegacyClassroomNotificationRowsLocked_(spreadsheet, sheetsBySource['Google Classroom']);
  removeEmptyDefaultSheetsLocked_(spreadsheet);

  // Retention/sorting belongs to ingestion. Reads must not rewrite every data row.
  return sheetsBySource;
}

function migrateLegacyNotificationSheet_(ss, sheetsBySource) {
  const props = PropertiesService.getUserProperties();
  const marker = String(ss.getId ? ss.getId() : 'default');
  if (props.getProperty(LEGACY_NOTIFICATION_MIGRATION_PROPERTY) === marker) return;
  const legacySheet = ss.getSheetByName(CONFIG.LEGACY_SHEET_NAME);

  if (!legacySheet) {
    props.setProperty(LEGACY_NOTIFICATION_MIGRATION_PROPERTY, marker);
    return;
  }

  if (legacySheet.getLastRow() >= 2) {
    const legacyRows = legacySheet.getDataRange().getValues().slice(1);

    NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
      const destinationSheet = sheetsBySource[storageConfig.source];
      const savedMessageIds = getSavedMessageIds_(destinationSheet);
      const rowsToMigrate = legacyRows
        .filter(row => String(row[2] || '') === storageConfig.source)
        .filter(row => {
          if (isClassroomApiManagedRow_(row)) return false;
          const messageId = String(row[1] || '').trim();

          if (!messageId || savedMessageIds.has(messageId)) {
            return false;
          }

          savedMessageIds.add(messageId);
          return true;
        })
        .map(row => normalizeNotificationRowWidth_(row));

      appendNotificationRows_(destinationSheet, rowsToMigrate);
    });
  }

  // Keep the legacy tab as a recoverable archive after its rows are copied.
  props.setProperty(LEGACY_NOTIFICATION_MIGRATION_PROPERTY, marker);
}

function normalizeNotificationRowWidth_(row) {
  const normalized = [];

  for (let i = 0; i < HEADER_ROW.length; i++) {
    normalized.push(row && row[i] !== undefined ? row[i] : '');
  }

  return normalized;
}

function appendNotificationRows_(sheet, rows) {
  if (!sheet || !Array.isArray(rows) || rows.length === 0) {
    return;
  }

  const isUnifiedInCampus = sheet.getName && sheet.getName() === INCAMPUS_SHEET_NAME;
  const width = isUnifiedInCampus ? Math.max(sheet.getLastColumn(), INCAMPUS_UNIFIED_HEADERS.length) : HEADER_ROW.length;
  const normalizedRows = rows.map(row => {
    if (!isUnifiedInCampus) return normalizeNotificationRowWidth_(row);
    const unified = Array(width).fill('');
    normalizeNotificationRowWidth_(row).forEach((value, index) => { unified[index] = value; });
    unified[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_GMAIL_RECORD_TYPE;
    return unified;
  });
  sheet
    .getRange(sheet.getLastRow() + 1, 1, normalizedRows.length, normalizedRows[0].length)
    .setValues(normalizedRows);
}

function parseNotificationReceivedDate_(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Subtract calendar months, clamping month-end dates (e.g. April 30 -> February 28).
function getNotificationRetentionCutoff_(referenceDate) {
  const cutoff = new Date(referenceDate);
  const day = cutoff.getDate();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - CONFIG.NOTIFICATION_RETENTION_MONTHS);
  const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  cutoff.setDate(Math.min(day, lastDay));
  return cutoff;
}

function normalizeNotificationRowsForStorage_(rows, storageConfig, referenceDate) {
  const now = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? new Date(referenceDate)
    : new Date();
  const earliest = getNotificationRetentionCutoff_(now);
  const seenMessageIds = new Set();

  return rows
    .map(row => normalizeNotificationRowWidth_(row))
    .filter(row => String(row[2] || '') === storageConfig.source)
    .filter(row => {
      if (isClassroomApiManagedRow_(row)) return true;
      const receivedDate = parseNotificationReceivedDate_(row[9]);

      // Keep unknown dates: they are not evidence that a message is old.
      if (!receivedDate || receivedDate.getTime() > earliest.getTime()) return true;
      // A dated Classroom announcement must survive storage cleanup until its date.
      if (storageConfig.source === 'Google Classroom' && getClassroomNotificationType_(row[11]) === 'newAnnouncement') {
        const expiry = getClassroomNoticeExpiry_(row[11], receivedDate);
        return expiry !== null && now.getTime() < expiry;
      }
      return false;
    })
    .sort((left, right) => {
      const leftDate = parseNotificationReceivedDate_(left[9]);
      const rightDate = parseNotificationReceivedDate_(right[9]);
      const receivedDiff = (rightDate ? rightDate.getTime() : 0) - (leftDate ? leftDate.getTime() : 0);

      if (receivedDiff !== 0) {
        return receivedDiff;
      }

      return getTimeForSort_(right[0]) - getTimeForSort_(left[0]);
    })
    .filter(row => {
      const messageId = String(row[1] || '').trim();

      if (!messageId || seenMessageIds.has(messageId)) {
        return false;
      }

      seenMessageIds.add(messageId);
      return true;
    });
}

function normalizeNotificationSheet_(sheet, storageConfig) {
  setupHeader_(sheet);

  if (storageConfig.source === 'inCampus') {
    normalizeUnifiedInCampusNotificationSheet_(sheet, storageConfig);
    return;
  }

  const currentRows = sheet.getLastRow() >= 2
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADER_ROW.length).getValues()
    : [];
  const normalizedRows = normalizeNotificationRowsForStorage_(currentRows, storageConfig);
  const rowsChanged = currentRows.length !== normalizedRows.length || normalizedRows.some((row, rowIndex) => {
    const originalRow = currentRows[rowIndex] || [];
    return row.some((value, columnIndex) => {
      const original = originalRow[columnIndex];
      if (value instanceof Date && original instanceof Date) {
        return value.getTime() !== original.getTime();
      }
      return value !== original;
    });
  });

  // A routine sync with no new mail should not rewrite every retained row.
  if (!rowsChanged) return;

  // Write retained rows first, then remove the obsolete tail below them.
  // The header stays in row 1 and the newest received message is in row 2.
  if (normalizedRows.length > 0) {
    sheet
      .getRange(2, 1, normalizedRows.length, HEADER_ROW.length)
      .setValues(normalizedRows);
  }

  const removedCount = currentRows.length - normalizedRows.length;
  if (removedCount > 0) {
    // Keep at least one unfrozen row even when every data row expires.
    if (sheet.getMaxRows() - removedCount < 2) {
      sheet.insertRowsAfter(sheet.getMaxRows(), 1);
    }
    sheet.deleteRows(normalizedRows.length + 2, removedCount);
  }

  SpreadsheetApp.flush();
}

function normalizeUnifiedInCampusNotificationSheet_(sheet, storageConfig) {
  setupInCampusUnifiedHeader_(sheet);
  const width = Math.max(sheet.getLastColumn(), INCAMPUS_UNIFIED_HEADERS.length);
  const allRows = sheet.getLastRow() >= 2
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues()
    : [];
  const gmailRows = [];
  const extractRows = [];
  const unclassifiedRows = [];
  allRows.forEach(row => {
    const recordType = String(row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] || '');
    if (recordType === INCAMPUS_EXTRACT_RECORD_TYPE) {
      extractRows.push(row);
    } else if (recordType === INCAMPUS_GMAIL_RECORD_TYPE ||
        (!recordType && String(row[2] || '') === 'inCampus')) {
      gmailRows.push(normalizeNotificationRowWidth_(row));
    } else if (row.some(value => value !== '' && value !== null && value !== undefined)) {
      // A future or malformed record type must never be removed by Gmail retention.
      unclassifiedRows.push(row);
    }
  });

  const retainedGmailRows = normalizeNotificationRowsForStorage_(gmailRows, storageConfig);
  const combined = retainedGmailRows.map(row => {
    const unified = Array(width).fill('');
    row.forEach((value, index) => { unified[index] = value; });
    unified[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_GMAIL_RECORD_TYPE;
    return unified;
  }).concat(extractRows.map(row => {
    const unified = Array(width).fill('');
    row.forEach((value, index) => { unified[index] = value; });
    unified[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_EXTRACT_RECORD_TYPE;
    return unified;
  })).concat(unclassifiedRows.map(row => {
    const unified = Array(width).fill('');
    row.forEach((value, index) => { unified[index] = value; });
    return unified;
  }));
  const sameCell = (left, right) => left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : left === right;
  const changed = allRows.length !== combined.length || combined.some((row, rowIndex) =>
    row.some((value, columnIndex) => !sameCell(value, (allRows[rowIndex] || [])[columnIndex]))
  );
  if (!changed) return;

  if (combined.length) sheet.getRange(2, 1, combined.length, width).setValues(combined);
  if (allRows.length > combined.length) {
    sheet.getRange(combined.length + 2, 1, allRows.length - combined.length, width).clearContent();
  }
  SpreadsheetApp.flush();
}

function setupHeader_(sheet) {
  const current = sheet.getRange(1, 1, 1, HEADER_ROW.length).getValues()[0];
  if (HEADER_ROW.some((name, index) => current[index] !== name)) {
    sheet.getRange(1, 1, 1, HEADER_ROW.length).setValues([HEADER_ROW]);
    sheet.setFrozenRows(1);
  }
}

function getSavedMessageIds_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return new Set();
  }

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const ids = values
    .map(row => String(row[0] || '').trim())
    .filter(id => id !== '');

  return new Set(ids);
}

function getSavedNotificationState_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {messageIds: new Set(), latestReceivedAt: null};

  // B:J contains both message IDs and the received timestamp (column J),
  // avoiding a second sheet read during sync preparation.
  const values = sheet.getRange(2, 2, lastRow - 1, 9).getValues();
  const messageIds = new Set();
  let latestReceivedAt = null;
  values.forEach(row => {
    const messageId = String(row[0] || '').trim();
    if (messageId) messageIds.add(messageId);
    if (messageId.startsWith('classroom-api:')) return;
    const receivedAt = parseNotificationReceivedDate_(row[8]);
    if (receivedAt && (!latestReceivedAt || receivedAt.getTime() > latestReceivedAt.getTime())) {
      latestReceivedAt = receivedAt;
    }
  });
  return {messageIds, latestReceivedAt};
}
