const CONFIG = {
  LEGACY_SHEET_NAME: '通知一覧',
  CLASSROOM_SHEET_NAME: 'Classroom通知',
  INCAMPUS_NOTIFICATION_SHEET_NAME: 'inCampus通知',
  NOTIFICATION_RETENTION_MONTHS: 2,
  BODY_LIMIT: 5000
};

const NOTIFICATION_STORAGE_CONFIGS = [
  {
    source: 'Google Classroom',
    sheetName: CONFIG.CLASSROOM_SHEET_NAME,
    // Search slightly beyond two calendar months; filter each message precisely.
    query: 'from:classroom.google.com newer_than:63d',
    initialQuery: 'from:classroom.google.com newer_than:20d',
    batchSize: 100
  },
  {
    source: 'inCampus',
    sheetName: CONFIG.INCAMPUS_NOTIFICATION_SHEET_NAME,
    query: 'from:no-reply-incampus@isc.senshu-u.ac.jp newer_than:63d',
    initialQuery: 'from:no-reply-incampus@isc.senshu-u.ac.jp newer_than:20d',
    batchSize: 100
  }
];

const AUTO_FETCH_HANDLER = 'saveClassroomMailsToSheet';
const AUTO_FETCH_TRIGGER_REVISION = 'short-lock-2026-10-03';
const AUTO_FETCH_TRIGGER_REVISION_PROPERTY = 'TASKHUB_AUTO_FETCH_TRIGGER_REVISION';
const NOTIFICATION_INITIAL_BACKFILL_PENDING_PROPERTY = 'TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING';
const NOTIFICATION_LAST_SUCCESSFUL_SYNC_PROPERTY = 'TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT';

const HEADER_ROW = [
  '保存日時',
  'メッセージID',
  '通知元',
  '授業名',
  '課題・通知タイトル',
  '期限',
  '期限状態',
  'メール件名',
  '送信者',
  '受信日時',
  'Gmailリンク',
  '本文',
  '確認状態',
  '完了日時',
  '更新レコード状態',
  '適用済み提出記録'
];

const TASK_KEYWORDS = [
  '課題',
  '宿題',
  'レポート',
  '小テスト',
  'リフレクション',
  '演習',
  '提出',
  'アンケート',
  '予習',
  '復習',
  'ワーク',
  '確認テスト',
  'アクティビティ'
];

function doGet() {
  ensureUserStorageForWeb_();

  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('課題通知Hub');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function ensureUserStorageForWeb_() {
  return runWithUserLock_('保存データ処理', () => ensureUserStorageForWebLocked_());
}

function ensureUserStorageForWebLocked_() {
  try {
    const ss = getOrCreateSpreadsheet_();

    ensureNotificationStorage_(ss);
    getOrCreateInCampusSheet_();
    const autoFetchTrigger = ensureAutoFetchTrigger_();

    return {
      ok: true,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      autoFetchTriggerCreated: autoFetchTrigger.created,
      removedDuplicateTriggers: autoFetchTrigger.removedDuplicates
    };
  } catch (error) {
    Logger.log('ユーザー用スプレッドシート初期化に失敗: ' + (error && error.message ? error.message : error));

    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function detectSource_(from) {
  const text = String(from || '').toLowerCase();

  if (text.includes('taskhub-test-classroom@example.invalid')) return 'Google Classroom';
  if (text.includes('taskhub-test-incampus@example.invalid')) return 'inCampus';

  if (text.includes('classroom.google.com')) {
    return 'Google Classroom';
  }

  if (text.includes('no-reply-incampus@isc.senshu-u.ac.jp')) {
    return 'inCampus';
  }

  return 'その他';
}

function isWithinLookback_(date, days) {
  if (!(date instanceof Date) || !Number.isInteger(days) || days <= 0) {
    return true;
  }

  const earliest = new Date();
  earliest.setDate(earliest.getDate() - days);
  earliest.setHours(0, 0, 0, 0);

  return date.getTime() >= earliest.getTime();
}

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
        reason: '保存Excelに有効な受信日時がないため、広範囲検索を避けて同期をスキップしました。'
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

// Globals are isolated per Apps Script execution. Nested operations share its lock.
let userStorageLockDepth_ = 0;
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
    throw new Error('テストケース用スプレッドシートを開けません。共有設定とIDを確認してください。');
  }

  const requiredSheets = [
    {name: 'テストClassroom', headers: TEST_CASE_NOTIFICATION_HEADERS},
    {name: 'テストinCampus', headers: TEST_CASE_NOTIFICATION_HEADERS},
    {name: 'テスト抽出', headers: TEST_CASE_EXTRACT_HEADERS}
  ];
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

function getNotificationReadSheets_(testSpreadsheet) {
  if (isTestCaseModeEnabled_()) {
    const ss = testSpreadsheet || openTestCaseSpreadsheet_();
    return {
      'Google Classroom': ss.getSheetByName('テストClassroom'),
      inCampus: ss.getSheetByName('テストinCampus')
    };
  }
  return ensureNotificationStorage_(getOrCreateSpreadsheet_());
}

function getInCampusReadSheet_(testSpreadsheet) {
  if (isTestCaseModeEnabled_()) return (testSpreadsheet || openTestCaseSpreadsheet_()).getSheetByName('テスト抽出');
  return getOrCreateInCampusSheet_();
}

function mapTestCaseNotificationRowForRead_(row, referenceDate) {
  const mapped = normalizeNotificationRowWidth_(row);
  if (isPresentValue_(row[16])) mapped[0] = row[16]; // テスト保存日時
  if (isPresentValue_(row[17])) mapped[9] = row[17]; // テスト受信日時
  if (isPresentValue_(row[19])) {
    const testReferenceDate = referenceDate instanceof Date
      ? referenceDate
      : isTestCaseModeEnabled_() ? getTestCaseReferenceNow_() : null;
    mapped[5] = rebaseTestCaseDeadline_(row[19], row[17], testReferenceDate);
  }
  return mapped;
}

function mapTestCaseExtractRowForRead_(row, referenceDate) {
  const mapped = row.slice();
  if (isPresentValue_(row[17])) mapped[12] = row[17]; // テスト受信日時
  if (isPresentValue_(row[19])) {
    const testReferenceDate = referenceDate instanceof Date
      ? referenceDate
      : isTestCaseModeEnabled_() ? getTestCaseReferenceNow_() : null;
    mapped[5] = rebaseTestCaseDeadline_(row[19], row[17], testReferenceDate);
  }
  return mapped;
}

function rebaseTestCaseDeadline_(deadlineValue, receivedAtValue, referenceDate) {
  if (!(referenceDate instanceof Date)) return deadlineValue;

  const deadline = deadlineValue instanceof Date ? new Date(deadlineValue) : new Date(deadlineValue);
  const receivedAt = receivedAtValue instanceof Date ? new Date(receivedAtValue) : new Date(receivedAtValue);
  if (Number.isNaN(deadline.getTime()) || Number.isNaN(receivedAt.getTime())) return deadlineValue;

  const deadlineDay = Date.UTC(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const receivedDay = Date.UTC(receivedAt.getFullYear(), receivedAt.getMonth(), receivedAt.getDate());
  const dayOffset = Math.round((deadlineDay - receivedDay) / (24 * 60 * 60 * 1000));
  const shifted = new Date(referenceDate);
  shifted.setDate(shifted.getDate() + dayOffset);
  shifted.setHours(deadline.getHours(), deadline.getMinutes(), deadline.getSeconds(), deadline.getMilliseconds());
  return shifted;
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

  setupHeader_(sheet);
  return sheet;
}

function ensureNotificationStorage_(ss) {
  return runWithUserLock_('保存データ処理', () => ensureNotificationStorageLocked_(ss));
}

function ensureNotificationStorageLocked_(ss) {
  const spreadsheet = ss || getOrCreateSpreadsheet_();
  const sheetsBySource = {};

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    sheetsBySource[storageConfig.source] = getOrCreateNotificationSheet_(spreadsheet, storageConfig.source);
  });

  migrateLegacyNotificationSheet_(spreadsheet, sheetsBySource);

  // Retention/sorting belongs to ingestion. Reads must not rewrite every data row.
  return sheetsBySource;
}

function migrateLegacyNotificationSheet_(ss, sheetsBySource) {
  const legacySheet = ss.getSheetByName(CONFIG.LEGACY_SHEET_NAME);

  if (!legacySheet) {
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

  ss.deleteSheet(legacySheet);
  SpreadsheetApp.flush();
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

  const normalizedRows = rows.map(row => normalizeNotificationRowWidth_(row));
  sheet
    .getRange(sheet.getLastRow() + 1, 1, normalizedRows.length, HEADER_ROW.length)
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
    const receivedAt = parseNotificationReceivedDate_(row[8]);
    if (receivedAt && (!latestReceivedAt || receivedAt.getTime() > latestReceivedAt.getTime())) {
      latestReceivedAt = receivedAt;
    }
  });
  return {messageIds, latestReceivedAt};
}

function extractNotificationInfo_(source, subject, body, receivedDate) {
  const dueInfo = extractDueDate_(`${subject}\n${body}`, receivedDate);

  if (source === 'inCampus') {
    return {
      courseName: extractInCampusCourseName_(body),
      title: extractInCampusTitle_(subject, body),
      dueDate: dueInfo.dueDate,
      dueStatus: dueInfo.dueStatus
    };
  }

  const courseName = extractCourseName_(body);
  const title = extractTitle_(subject, body);

  return {
    courseName,
    title,
    dueDate: dueInfo.dueDate,
    dueStatus: dueInfo.dueStatus
  };
}

function extractInCampusCourseName_(body) {
  const lines = getCleanLines_(body);
  const courseLine = lines.find(line => /^授業名\s*[:：]/.test(line));

  if (!courseLine) {
    return 'inCampusお知らせ';
  }

  const courseName = courseLine.replace(/^授業名\s*[:：]\s*/, '').trim();

  return courseName || 'inCampusお知らせ';
}

function extractInCampusTitle_(subject, body) {
  if (/^\s*お知らせ内容\s*[:：]/m.test(String(body || ''))) return subject || 'タイトル未抽出';
  const updateLines = getInCampusUpdateLines_(body);

  for (const line of updateLines) {
    const title = extractInCampusUpdateTitle_(line);

    if (title) {
      return title;
    }
  }

  return subject || 'タイトル未抽出';
}

function getInCampusUpdateLines_(body) {
  const lines = getCleanLines_(body);
  const markerIndex = lines.findIndex(line => /^更新内容\s*[:：]/.test(line));

  if (markerIndex === -1) {
    return lines;
  }

  return lines.slice(markerIndex + 1);
}

function getInCampusUpdateKind_(value) {
  const prefix = String(value || '').trim().replace(/^[・･·\s]+/, '').slice(0, 2);
  return prefix === '課題' ? 'assignment' : prefix === 'お知' ? 'announcement' : '';
}

function extractInCampusUpdateTitle_(value) {
  const text = String(value || '').trim().replace(/^[・･·\s]+/, '');
  const match = text.match(/^(?:課題|お知らせ)\s*[（(](.*)[）)]\s*(?:が|を)/) ||
    text.match(/^(?:課題|お知らせ)\s*[「『](.*)[」』]\s*(?:が|を)/);
  return match ? match[1].trim() : '';
}

function getInCampusMailKind_(body) {
  const fields = extractRequiredInCampusFieldsFromBody_(body);
  if (fields) return getInCampusUpdateKind_(fields.updateContent);
  const lines = getCleanLines_(body);
  if (lines.some(line => /^お知らせ内容\s*[:：]/.test(line))) return 'announcement';
  const marker = lines.findIndex(line => /^更新内容\s*[:：]/.test(line));
  if (marker >= 0) {
    const line = lines[marker].replace(/^更新内容\s*[:：]\s*/, '') || lines[marker + 1] || '';
    return getInCampusUpdateKind_(line);
  }
  return '';
}

function extractInCampusAddedItemTitle_(line) {
  if (getInCampusUpdateKind_(line) !== 'assignment' || !/が(?:追加|更新)されました/.test(line)) return '';
  return extractInCampusUpdateTitle_(line);
}

function isInCampusTaskRelated_(subject, body) {
  const text = `${subject || ''}\n${body || ''}`;

  if (isNonActionableNotification_(text)) {
    return false;
  }

  const lines = getInCampusUpdateLines_(body);

  return lines.some(line => extractInCampusAddedItemTitle_(line) !== '');
}

function extractRequiredInCampusFieldsFromBody_(body) {
  const lines = getCleanLines_(body);
  let fields = {
    weekdayPeriod: '',
    courseName: '',
    teacherName: '',
    updateContent: ''
  };

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    let match = line.match(/^(?:曜日・時限|時限・曜日)\s*[:：]\s*(.+)$/);

    if (match) {
      fields = {
        weekdayPeriod: String(match[1] || '').trim(),
        courseName: '',
        teacherName: '',
        updateContent: ''
      };
      continue;
    }

    match = line.match(/^授業名\s*[:：]\s*(.+)$/);

    if (match) {
      fields.courseName = String(match[1] || '').trim();
      continue;
    }

    match = line.match(/^(?:教員名|発信者)\s*[:：]\s*(.+)$/);

    if (match) {
      fields.teacherName = String(match[1] || '').trim();
      continue;
    }

    match = line.match(/^更新内容\s*[:：]\s*(.*)$/);

    if (!match) {
      continue;
    }

    const inlineContent = String(match[1] || '').trim();
    const nextLine = inlineContent || String(lines[i + 1] || '').trim();

    if (
      !nextLine ||
      /^(曜日・時限|授業名|教員名|更新内容)\s*[:：]/.test(nextLine) ||
      /^=+$/.test(nextLine) ||
      nextLine.startsWith('※※')
    ) {
      continue;
    }

    fields.updateContent = nextLine;

    if (
      fields.weekdayPeriod &&
      fields.courseName &&
      fields.teacherName &&
      fields.updateContent
    ) {
      return fields;
    }
  }

  return null;
}

function extractInCampusMailRecords_(subject, body, receivedDate) {
  const lines = getCleanLines_(`${subject || ''}\n${body || ''}`);
  const records = [];
  let weekdayPeriod = '';
  let courseName = '';
  let teacherName = '';

  lines.forEach(line => {
    const text = String(line || '').trim();
    let match = text.match(/^(?:曜日・時限|時限・曜日)\s*[:：]\s*(.+)$/);

    if (match) {
      weekdayPeriod = String(match[1] || '').trim();
      courseName = '';
      teacherName = '';
      return;
    }

    match = text.match(/^授業名\s*[:：]\s*(.+)$/);

    if (match) {
      courseName = String(match[1] || '').trim();
      return;
    }

    match = text.match(/^(?:教員名|発信者)\s*[:：]\s*(.+)$/);

    if (match) {
      teacherName = String(match[1] || '').trim();
      return;
    }

    const bracketCourseName = extractInCampusCourseNameFromBracketLine_(text);

    if (bracketCourseName) {
      courseName = bracketCourseName;
      return;
    }

    const addedTitle = extractInCampusAddedItemTitle_(text);
    const submittedTitle = extractInCampusSubmittedItemTitle_(text);
    const announcementTitle = getInCampusUpdateKind_(text) === 'announcement' ? extractInCampusUpdateTitle_(text) : '';

    if (!addedTitle && !submittedTitle && !announcementTitle) {
      return;
    }

    const recordType = submittedTitle ? 'submission' : announcementTitle ? 'announcement' : 'assignment';
    const title = submittedTitle || addedTitle || announcementTitle;

    records.push({
      type: recordType,
      weekdayPeriod,
      teacherName,
      courseName: courseName || 'inCampusお知らせ',
      title,
      occurredAt: extractDateTimeFromInCampusLine_(text, receivedDate),
      body: buildInCampusMailRecordBody_(weekdayPeriod, courseName, teacherName, text)
    });
  });

  return deduplicateInCampusMailRecords_(records);
}

function buildInCampusMailRecordBody_(weekdayPeriod, courseName, teacherName, updateLine) {
  return [
    weekdayPeriod ? `曜日・時限：${weekdayPeriod}` : '',
    courseName ? `授業名：${courseName}` : '',
    teacherName ? `教員名：${teacherName}` : '',
    '更新内容：',
    updateLine
  ].filter(Boolean).join('\n');
}

function extractInCampusSubmissionRecords_(subject, body, receivedDate) {
  return extractInCampusMailRecords_(subject, body, receivedDate)
    .filter(record => record.type === 'submission')
    .map(record => ({
      courseName: record.courseName,
      weekdayPeriod: record.weekdayPeriod,
      title: record.title,
      submittedAt: record.occurredAt,
      body: record.body
    }));
}

function extractInCampusSubmittedItemTitle_(line) {
  const text = String(line || '').trim();
  const patterns = [
    /[・\s]*課題\s*[（(](.+?)[）)]\s*を提出しました/,
    /[・\s]*課題\s*[「『]([^」』]+)[」』]\s*を提出しました/,
    /[・\s]*課題\s*[（(](.+?)[）)]\s*が提出されました/,
    /[・\s]*課題\s*[「『]([^」』]+)[」』]\s*が提出されました/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const title = String(match[1] || '').trim();

    if (title) {
      return title;
    }
  }

  return '';
}

function extractInCampusCourseNameFromBracketLine_(line) {
  const text = String(line || '').trim();
  const match = text.match(/^\[([^\]]+)\]$/);

  if (!match) {
    return '';
  }

  const courseName = String(match[1] || '')
    .replace(/^[月火水木金土日]\d+\s*/, '')
    .trim();

  return courseName;
}

function extractDateTimeFromInCampusLine_(line, receivedDate) {
  const text = String(line || '');
  let match = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})/);

  if (match) {
    return buildDateWithTime_(match[1], match[2], match[3], match[4]);
  }

  match = text.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})(?!\d)/);

  if (!match) {
    return '';
  }

  const parsedReceivedDate = receivedDate instanceof Date
    ? receivedDate
    : new Date(receivedDate);
  const baseDate = Number.isNaN(parsedReceivedDate.getTime())
    ? new Date()
    : parsedReceivedDate;
  const resolveYear = createMonthDayYearResolver_(baseDate);
  const year = resolveYear(match[1], match[2]);

  return buildDateWithTime_(year, match[1], match[2], match[3]);
}

function applySavedInCampusSubmissionRecords_(sheet) {
  return runWithUserLock_('保存データ処理', () => applySavedInCampusSubmissionRecordsLocked_(sheet));
}

function applySavedInCampusSubmissionRecordsLocked_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getDataRange().getValues();
  let completedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[2]) !== 'inCampus') continue;
    const ledger = parseInCampusRawJson_(row[15]);
    extractInCampusSubmissionRecords_(row[7], row[11], row[9]).forEach(record => {
      const eventKey = buildInCampusSubmissionEventKey_(record, row[1], row[9]);
      const existingTargets = ledger[eventKey];
      const candidates = findMatchingInCampusMailRecords_(values, record, row[9]);
      const targets = Array.isArray(existingTargets) ? existingTargets : candidates.map(target => target.row[1]);
      if (!targets.length) return; // Retry an unmatched event after older mail arrives.
      if (!existingTargets) {
        ledger[eventKey] = targets;
        row[15] = JSON.stringify(ledger);
        // Bind first, so a retry after a partial failure can never choose another task.
        sheet.getRange(i + 1, 16).setValue(row[15]);
      }
      targets.forEach(targetId => {
        const target = findInCampusLogicalRecordById_(values, targetId);
        if (target && setInCampusLogicalRecordStatus_(sheet, values, target, '完了', record.submittedAt || row[9], eventKey)) completedCount++;
      });
    });
  }
  return completedCount;
}

function completeMatchingInCampusMailRow_(sheet, record, fallbackCompletedAt) {
  return runWithUserLock_('保存データ処理', () => completeMatchingInCampusMailRowLocked_(sheet, record, fallbackCompletedAt));
}

function completeMatchingInCampusMailRowLocked_(sheet, record, fallbackCompletedAt) {
  if (!record || !record.title || !sheet || sheet.getLastRow() < 2) return false;
  const values = sheet.getDataRange().getValues();
  const eventKey = buildInCampusSubmissionEventKey_(record, '', fallbackCompletedAt);
  let changed = false;
  findMatchingInCampusMailRecords_(values, record, fallbackCompletedAt).forEach(target => {
    if (setInCampusLogicalRecordStatus_(sheet, values, target, '完了', record.submittedAt || fallbackCompletedAt || new Date(), eventKey)) changed = true;
  });
  return changed;
}

// The source email remains intact; only independent logical states are stored beside it.
function inCampusStableKey_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('').slice(0, 32);
}

function inCampusRecordIdentity_(record) {
  const course = getInCampusCourseIdentity_(record);
  return [record.type, normalizeInCampusMatchText_(course.name), course.schedule,
    normalizeInCampusMatchText_(record.title), record.type === 'submission' ? getTimeForSort_(record.occurredAt) : ''].join('|');
}

function deduplicateInCampusMailRecords_(records) {
  const byIdentity = new Map();
  records.forEach(record => {
    const identity = inCampusRecordIdentity_(record);
    const previous = byIdentity.get(identity);
    // Added + updated in one email refers to the same logical assignment.
    if (previous) record.occurredAt = previous.occurredAt || record.occurredAt;
    byIdentity.set(identity, record);
  });
  return Array.from(byIdentity.values());
}

function getLegacyInCampusRecordIndex_(row, records) {
  const index = records.findIndex(record => normalizeInCampusMatchText_(record.title) === normalizeInCampusMatchText_(row[4]) &&
    normalizeInCampusCourseNameForMatch_(record.courseName) === normalizeInCampusCourseNameForMatch_(row[3]));
  return index >= 0 ? index : 0;
}

function expandInCampusNotificationRow_(row) {
  if (String(row[2]) !== 'inCampus') return [row];
  const records = extractInCampusMailRecords_(row[7], row[11], row[9]);
  if (!records.length) return [row];
  const states = parseInCampusRawJson_(row[14]);
  const legacyIndex = getLegacyInCampusRecordIndex_(row, records);
  return records.map((record, index) => {
    const child = normalizeNotificationRowWidth_(row);
    const key = inCampusStableKey_(inCampusRecordIdentity_(record));
    const state = states[key] || {};
    child[1] = String(row[1]) + ':update:' + key;
    child.originalMessageIdForState = index === legacyIndex ? String(row[1]) : '';
    child[3] = record.courseName;
    child[4] = record.title;
    child[11] = record.body;
    // Update timestamps describe delivery events, not submission deadlines.
    const explicitDeadline = String(record.body).split('\n').filter(line => /^\s*(?:提出期限|期限|締切|締め切り|しめきり)\s*[:：]/.test(line)).join('\n');
    const due = extractDueDate_(explicitDeadline, row[9]);
    child[5] = due.dueDate;
    child[6] = record.type === 'submission' ? '提出記録' : due.dueStatus;
    child[12] = state.status || (record.type === 'submission' ? '完了記録' : index === legacyIndex ? row[12] : '未確認');
    child[13] = Object.prototype.hasOwnProperty.call(state, 'completedAt') ? state.completedAt : index === legacyIndex ? row[13] : '';
    return child;
  });
}

function findInCampusLogicalRecordById_(values, messageId) {
  for (let index = 1; index < values.length; index++) {
    if (String(values[index][2]) !== 'inCampus') continue;
    const children = expandInCampusNotificationRow_(values[index]);
    const row = children.find(child => String(child[1]) === String(messageId));
    if (row) return {index, row};
  }
  return null;
}

function buildInCampusSubmissionEventKey_(record, fallbackId, fallbackTime) {
  return inCampusStableKey_([normalizeInCampusMatchText_(record.courseName),
    getInCampusCourseIdentity_(record).schedule, normalizeInCampusMatchText_(record.title),
    getTimeForSort_(record.submittedAt || fallbackTime) || String(fallbackId || '')].join('|'));
}

function findMatchingInCampusMailRecords_(values, record, fallbackTime) {
  const submittedAt = getTimeForSort_(record.submittedAt || fallbackTime);
  const matches = [];
  values.slice(1).forEach((raw, offset) => {
    if (String(raw[2]) !== 'inCampus') return;
    const records = extractInCampusMailRecords_(raw[7], raw[11], raw[9]);
    expandInCampusNotificationRow_(raw).forEach((row, recordIndex) => {
      if (!isTaskRelatedRow_(row)) return;
      const fields = extractRequiredInCampusFieldsFromBody_(row[11]) || {};
      if (!isSameInCampusAssignmentForWeb_(record, {title: row[4], courseName: row[3], weekdayPeriod: fields.weekdayPeriod})) return;
      const occurredAt = getTimeForSort_(records[recordIndex] && records[recordIndex].occurredAt || raw[9]);
      if (submittedAt && occurredAt && occurredAt > submittedAt) return;
      matches.push({index: offset + 1, row, occurredAt});
    });
  });
  if (!matches.length) return [];
  // A reused title must not cause an old submission to complete a newer assignment.
  const latest = Math.max(...matches.map(match => match.occurredAt));
  const candidates = matches.filter(match => match.occurredAt === latest);
  const schedules = new Set(candidates.map(match => getInCampusCourseIdentity_({courseName: match.row[3],
    weekdayPeriod: (extractRequiredInCampusFieldsFromBody_(match.row[11]) || {}).weekdayPeriod}).schedule));
  return schedules.size > 1 ? [] : candidates;
}

function setInCampusLogicalRecordStatus_(sheet, values, target, status, completedAt, eventKey) {
  const raw = values[target.index];
  const states = parseInCampusRawJson_(raw[14]);
  const suffix = String(target.row[1]).split(':update:')[1];
  const key = suffix || 'legacy';
  const state = states[key] || {};
  const events = state.appliedSubmissionEvents || {};
  if (eventKey && events[eventKey]) return false;
  if (eventKey) events[eventKey] = true;
  states[key] = Object.assign({}, state, {status, completedAt: status === '完了' ? completedAt || new Date() : '', appliedSubmissionEvents: events});
  raw[14] = JSON.stringify(states);
  sheet.getRange(target.index + 1, 15).setValue(raw[14]);
  if (!suffix) {
    raw[12] = status;
    raw[13] = status === '完了' ? completedAt || new Date() : '';
    sheet.getRange(target.index + 1, 13, 1, 2).setValues([[raw[12], raw[13]]]);
  }
  return true;
}

function normalizeInCampusMatchText_(value) {
  return normalizeTextWidth_(value)
    .replace(/[（）]/g, character => character === '（' ? '(' : ')')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function normalizeTextWidth_(value) {
  const text = String(value || '');

  return typeof text.normalize === 'function'
    ? text.normalize('NFKC')
    : text;
}

function normalizeInCampusCourseNameForMatch_(value) {
  return normalizeInCampusMatchText_(
    String(value || '').replace(/^[月火水木金土日]\d+/, '')
  );
}

function extractClassroomUrl_(source, body) {
  if (source !== 'Google Classroom') {
    return '';
  }

  const candidates = extractClassroomUrlCandidates_(body);
  const assignmentUrl = candidates.find(url => isClassroomAssignmentUrl_(url));

  return assignmentUrl || candidates[0] || '';
}

function extractClassroomUrlCandidates_(body) {
  const content = removeEmailFooterForUrlExtraction_(body);
  const lines = String(content || '')
    .split(/\r?\n/)
    .map(line => line.trim());
  const candidates = [];
  const seen = {};
  const addCandidate = value => {
    const normalizedUrl = normalizeClassroomUrlForMatch_(value);

    if (!normalizedUrl || seen[normalizedUrl]) {
      return;
    }

    seen[normalizedUrl] = true;
    candidates.push(normalizedUrl);
  };
  const markerTexts = [
    '詳細を表示',
    '課題を表示',
    '返信'
  ];

  for (const markerText of markerTexts) {
    const url = getClassroomUrlFromNextLine_(lines, markerText);

    if (url) {
      addCandidate(url);
    }
  }

  for (const line of lines) {
    addCandidate(extractClassroomUrlFromLine_(line));
  }

  return candidates;
}

function isClassroomAssignmentUrl_(value) {
  return /\/c\/[^/]+\/a\/[^/]+\/details$/.test(String(value || ''));
}

function removeEmailFooterForUrlExtraction_(body) {
  const text = String(body || '');
  const footerMarker = 'Google LLC 1600 Amphitheatre Parkway';
  const footerIndex = text.indexOf(footerMarker);

  if (footerIndex >= 0) {
    return text.slice(0, footerIndex);
  }

  return text;
}

function getClassroomUrlFromNextLine_(lines, markerText) {
  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = String(lines[i] || '').trim();

    if (currentLine === markerText || currentLine.includes(markerText)) {
      return extractClassroomUrlFromLine_(lines[i + 1]);
    }
  }

  return '';
}

function extractClassroomUrlFromLine_(line) {
  const text = String(line || '').trim();
  const decodedText = decodeUrlTextForClassroom_(text);

  if (!text.includes('classroom.google.com') && !decodedText.includes('classroom.google.com')) {
    return '';
  }

  const targetText = text.includes('classroom.google.com') ? text : decodedText;
  const angleMatch = targetText.match(/<([^<>]*classroom\.google\.com[^<>]*)>/);

  if (angleMatch) {
    return angleMatch[1].trim();
  }

  const bareMatch = targetText.match(/https?:\/\/[^\s<>]+/);

  if (!bareMatch) {
    return '';
  }

  const url = bareMatch[0]
    .replace(/[、。]+$/g, '')
    .trim();

  if (!url.includes('classroom.google.com')) {
    return '';
  }

  return url;
}

function decodeUrlTextForClassroom_(value) {
  let text = String(value || '');

  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(text);

      if (decoded === text) {
        return decoded;
      }

      text = decoded;
    } catch (error) {
      return text;
    }
  }

  return text;
}

function extractCourseName_(body) {
  const lines = getClassroomMeaningfulLines_(body);

  if (lines.length > 0 && !isClassroomNotificationMarker_(lines[0])) {
    return lines[0];
  }

  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  if (markerIndex > 0) {
    return lines[markerIndex - 1];
  }

  return '授業名未抽出';
}

function extractTitle_(subject, body) {
  const subjectText = String(subject || '');
  const subjectMatch = subjectText.match(/(?:新しい課題|新しいお知らせ|新しい資料)[:：]\s*[「"]?(.+?)[」"]?$/);

  if (subjectMatch) {
    return subjectMatch[1].trim();
  }

  const lines = getClassroomMeaningfulLines_(body);
  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  if (markerIndex >= 0) {
    const titleCandidate = lines
      .slice(markerIndex + 1)
      .find(line => {
        if (isClassroomNotificationMarker_(line)) {
          return false;
        }

        if (line.includes('先生が')) {
          return false;
        }

        return !isNoiseLine_(line);
      });

    if (titleCandidate) {
      return titleCandidate;
    }
  }

  for (const line of lines) {
    if (isNoiseLine_(line)) {
      continue;
    }

    if (line.includes('課題を表示') || line.includes('成績を表示')) {
      continue;
    }

    if (TASK_KEYWORDS.some(keyword => line.includes(keyword))) {
      return line;
    }
  }

  return 'タイトル未抽出';
}

function getCleanLines_(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

function isNoiseLine_(line) {
  const text = String(line || '').trim();

  if (text === '') {
    return true;
  }

  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('<http')) {
    return true;
  }

  if (text.includes('accounts.google.com')) {
    return true;
  }

  if (text.includes('Google LLC')) {
    return true;
  }

  if (text.includes('このメールは、Google Classroom')) {
    return true;
  }

  if (text.includes('通知設定')) {
    return true;
  }

  return false;
}

function extractDueDate_(text, receivedDate) {
  const sourceText = String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:投稿日|投稿日時|送信日時|メール受信日時|通知日時)\s*[:：]/.test(line))
    .join('\n')
    .replace(/https?:\/\/[^\s<>]+/g, ' ');
  const monthDayYearResolver = createMonthDayYearResolver_(receivedDate);

  if (
    sourceText.includes('期限なし') ||
    sourceText.includes('締切なし') ||
    sourceText.includes('提出期限なし')
  ) {
    return {
      dueDate: '期限なし',
      dueStatus: '期限なし'
    };
  }

  let result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  if (
    sourceText.includes('明日まで') ||
    sourceText.includes('明日締切') ||
    sourceText.includes('明日提出')
  ) {
    const due = new Date(receivedDate);
    due.setDate(due.getDate() + 1);

    return {
      dueDate: formatDateObject_(due),
      dueStatus: '相対日付抽出'
    };
  }

  const weekdayMatch = sourceText.match(/今週\s*(月曜|火曜|水曜|木曜|金曜|土曜|日曜|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日)まで/);

  if (weekdayMatch) {
    const due = getDateOfThisWeekday_(receivedDate, weekdayMatch[1]);

    return {
      dueDate: formatDateObject_(due),
      dueStatus: '相対日付抽出'
    };
  }

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  return {
    dueDate: '',
    dueStatus: '期限未検出・要確認'
  };
}

function findValidDueDate_(text, regex, status, fixedYear) {
  let match;

  while ((match = regex.exec(text)) !== null) {
    let year;
    let month;
    let day;
    let time;

    if (fixedYear) {
      year = typeof fixedYear === 'function'
        ? fixedYear(match[1], match[2])
        : fixedYear;
      month = match[1];
      day = match[2];
      time = match[3];
    } else {
      year = match[1];
      month = match[2];
      day = match[3];
      time = match[4];
    }

    const result = buildDueDateResult_(year, month, day, time, status);

    if (result) {
      return result;
    }
  }

  return null;
}

function buildDueDateResult_(year, month, day, timeText, status) {
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);

  if (!isValidDateParts_(yearNum, monthNum, dayNum)) {
    return null;
  }

  const time = normalizeTimeText_(timeText);

  return {
    dueDate: formatDueDate_(yearNum, monthNum, dayNum, time),
    dueStatus: status
  };
}

function formatDueDate_(year, month, day, time) {
  const y = String(year);
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');

  if (time) {
    return `${y}/${m}/${d} ${time}`;
  }

  return `${y}/${m}/${d}`;
}

function getYearFromDate_(date) {
  if (date instanceof Date) {
    return date.getFullYear();
  }

  return new Date().getFullYear();
}

function createMonthDayYearResolver_(receivedDate) {
  const base = receivedDate instanceof Date
    ? new Date(receivedDate)
    : new Date();

  base.setHours(0, 0, 0, 0);

  return (month, day) => {
    const baseYear = base.getFullYear();
    const monthNum = Number(month);
    const dayNum = Number(day);

    if (!isValidDateParts_(baseYear, monthNum, dayNum)) {
      return baseYear;
    }

    const candidate = new Date(baseYear, monthNum - 1, dayNum);
    const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;

    if (candidate.getTime() < base.getTime() - sixMonthsMs) {
      return baseYear + 1;
    }

    return baseYear;
  };
}

function formatDateObject_(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}/${m}/${d}`;
}

function getDateOfThisWeekday_(baseDate, weekdayText) {
  const weekdayMap = {
    '日曜': 0,
    '日曜日': 0,
    '月曜': 1,
    '月曜日': 1,
    '火曜': 2,
    '火曜日': 2,
    '水曜': 3,
    '水曜日': 3,
    '木曜': 4,
    '木曜日': 4,
    '金曜': 5,
    '金曜日': 5,
    '土曜': 6,
    '土曜日': 6
  };

  const targetDay = weekdayMap[weekdayText];

  if (targetDay === undefined) {
    return new Date(baseDate);
  }

  const base = new Date(baseDate);
  const diff = targetDay - base.getDay();

  base.setDate(base.getDate() + diff);

  return base;
}

function getNotificationsForWeb() {
  return runWithUserLock_('保存データ処理', () => getNotificationsForWebLocked_());
}

function getNotificationsForWebLocked_() {
  const testMode = isTestCaseModeEnabled_();
  const deadlineReferenceNow = testMode ? getTestCaseReferenceNow_() : new Date(Date.now());
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    getActiveNotificationItemsForWeb_(testSpreadsheet, testStates),
    getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates),
    'assignment',
    testMode
  );

  return data
    .filter(item => !isExpiredNotificationForWeb_(item, deadlineReferenceNow))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item))
    .sort((a, b) => b.receivedAtTime - a.receivedAtTime);
}

function getActiveNotificationItemsForWeb_(testSpreadsheet, testStates) {
  return runWithUserLock_('保存データ処理', () => getActiveNotificationItemsForWebLocked_(testSpreadsheet, testStates));
}

function getActiveNotificationItemsForWebLocked_(testSpreadsheet, testStates) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const sheetsBySource = getNotificationReadSheets_(testSpreadsheet);
  let rows = getNotificationRowsFromSheets_(sheetsBySource, testMode);
  applyTestNotificationStatesToRows_(rows, testStates);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') !== '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
}

function getNotificationRowsFromSheets_(sheetsBySource, testMode) {
  const rows = [];
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  const testReferenceDate = useTestMode ? getTestCaseReferenceNow_() : null;

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource && sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() < 2) {
      return;
    }

    const sourceRows = sheet.getDataRange().getValues().slice(1);
    const rowsForRead = useTestMode
      ? sourceRows.map(row => mapTestCaseNotificationRowForRead_(row, testReferenceDate))
      : sourceRows;
    const retainedRows = normalizeNotificationRowsForStorage_(rowsForRead, storageConfig);
    retainedRows.forEach(row => rows.push(...expandInCampusNotificationRow_(row)));
  });

  return rows;
}

function getTestNotificationStateMap_() {
  if (!isTestCaseModeEnabled_()) return {};
  const prefix = TEST_NOTIFICATION_STATE_PROPERTY_PREFIX;
  const properties = PropertiesService.getUserProperties().getProperties();
  const states = {};
  Object.keys(properties).forEach(key => {
    if (!key.startsWith(prefix)) return;
    try {
      const state = JSON.parse(properties[key]);
      if (state && (state.status === '完了' || state.status === '未確認')) {
        states[key.slice(prefix.length)] = state;
      }
    } catch (_) {
      // Ignore malformed per-user test state and keep the spreadsheet value.
    }
  });
  return states;
}

function getTestNotificationState_(messageId, testStates) {
  if (!isTestCaseModeEnabled_()) return null;
  if (testStates) return testStates[String(messageId || '')] || null;
  const raw = PropertiesService.getUserProperties().getProperty(TEST_NOTIFICATION_STATE_PROPERTY_PREFIX + String(messageId || ''));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state && (state.status === '完了' || state.status === '未確認') ? state : null;
  } catch (_) {
    return null;
  }
}

function saveTestNotificationState_(messageId, status) {
  const id = String(messageId || '');
  if (!id || id.length > 450 || (status !== '完了' && status !== '未確認')) return false;
  const state = {status, completedAt: status === '完了' ? new Date().toISOString() : ''};
  PropertiesService.getUserProperties().setProperty(TEST_NOTIFICATION_STATE_PROPERTY_PREFIX + id, JSON.stringify(state));
  return true;
}

function clearTestNotificationStates_() {
  const props = PropertiesService.getUserProperties();
  Object.keys(props.getProperties()).forEach(key => {
    if (key.indexOf(TEST_NOTIFICATION_STATE_PROPERTY_PREFIX) === 0 || key.indexOf('universityNotice:test:') === 0) {
      props.deleteProperty(key);
    }
  });
}

function applyTestNotificationStatesToRows_(rows, testStates) {
  if (testStates !== undefined ? !testStates : !isTestCaseModeEnabled_()) return rows;
  const states = testStates || getTestNotificationStateMap_();
  rows.forEach(row => {
    const state = states[String(row[1] || '')] || null;
    if (!state) return;
    row[12] = state.status;
    row[13] = state.completedAt || '';
  });
  return rows;
}

function applyTestNotificationStateToItem_(item, testStates) {
  const state = testStates !== undefined
    ? (testStates && testStates[String(item && item.messageId || '')] || null)
    : getTestNotificationState_(item && item.messageId);
  if (!state) return item;
  item.status = state.status;
  item.completedAt = state.completedAt || '';
  item.completedAtTime = getTimeForSort_(state.completedAt);
  return item;
}


function getTimeForSort_(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  const date = new Date(value);
  const time = date.getTime();

  if (Number.isNaN(time)) {
    return 0;
  }

  return time;
}

function buildDeadlineDateTimeForWeb_(dateKey, dueTime) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!isValidDateParts_(year, month, day)) {
    return null;
  }

  let hour = 23;
  let minute = 59;

  if (dueTime) {
    const parts = String(dueTime).split(':');

    if (parts.length === 2) {
      const parsedHour = Number(parts[0]);
      const parsedMinute = Number(parts[1]);

      if (
        Number.isInteger(parsedHour) &&
        Number.isInteger(parsedMinute) &&
        parsedHour >= 0 &&
        parsedHour <= 23 &&
        parsedMinute >= 0 &&
        parsedMinute <= 59
      ) {
        hour = parsedHour;
        minute = parsedMinute;
      }
    }
  }

  // Deadline inputs have minute precision; treat the full minute as valid.
  return new Date(year, month - 1, day, hour, minute, 59, 999);
}

function isExpiredNotificationForWeb_(item, referenceNow) {
  if (item.dueType !== 'detected') {
    return false;
  }

  if (!item.dueDateKey) {
    return false;
  }

  const deadline = buildDeadlineDateTimeForWeb_(item.dueDateKey, item.dueTime);

  if (!deadline) {
    return false;
  }

  const now = referenceNow instanceof Date
    ? referenceNow
    : isTestCaseModeEnabled_() ? getTestCaseReferenceNow_() : new Date(Date.now());
  return deadline.getTime() < now.getTime();
}

function isStaleUnknownDueNotificationForWeb_(item) {
  if (item.dueType !== 'unknown') {
    return false;
  }

  if (!item.receivedAtTime) {
    return false;
  }

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const deadline = item.receivedAtTime + ONE_WEEK_MS;

  return deadline < Date.now();
}

function isClassroomUrlOrWrappedUrlLine_(line) {
  const text = String(line || '').trim();

  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('<http')) {
    return true;
  }

  if (text.includes('accounts.google.com')) {
    return true;
  }

  if (text.includes('classroom.google.com')) {
    return true;
  }

  if (text.includes('continue=')) {
    return true;
  }

  if (text.includes('Email=')) {
    return true;
  }

  if (text.includes('email%3D')) {
    return true;
  }

  if (text.includes('senshu-u.jp')) {
    return true;
  }

  return false;
}

function getClassroomMeaningfulLines_(body) {
  return getCleanLines_(body)
    .filter(line => {
      const text = String(line || '').trim();

      if (text === '') {
        return false;
      }

      if (text === '通知設定') {
        return false;
      }

      if (text === '詳細を表示') {
        return false;
      }

      if (text === '課題を表示') {
        return false;
      }

      if (text === '成績を表示') {
        return false;
      }

      if (text === '返信') {
        return false;
      }

      if (isClassroomUrlOrWrappedUrlLine_(text)) {
        return false;
      }

      if (text.includes('Google LLC')) {
        return false;
      }

      if (text.includes('このメールは、Google Classroom')) {
        return false;
      }

      if (text.includes('配信停止')) {
        return false;
      }

      if (text.includes('設定の変更')) {
        return false;
      }

      if (text.startsWith('投稿日:')) {
        return false;
      }

      return true;
    });
}

function isClassroomNotificationMarker_(line) {
  const text = String(line || '').trim();

  return text.includes('新しい課題') ||
    text.includes('新しい資料') ||
    text.includes('新しいお知らせ') ||
    text.includes('限定公開のコメント') ||
    text.includes('返却済み') ||
    text.includes('返却された課題');
}

function getClassroomNotificationMarkerIndex_(lines) {
  return lines.findIndex(line => isClassroomNotificationMarker_(line));
}

function getClassroomNotificationType_(body) {
  const lines = getClassroomMeaningfulLines_(body);
  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  const headText = markerIndex >= 0
    ? lines.slice(Math.max(0, markerIndex - 1), markerIndex + 2).join('\n')
    : lines.slice(0, 7).join('\n');

  if (headText.includes('新しい資料')) {
    return 'newMaterial';
  }

  if (headText.includes('限定公開のコメント')) {
    return 'privateComment';
  }

  if (
    headText.includes('返却済み') ||
    headText.includes('返却された課題')
  ) {
    return 'returned';
  }

  if (headText.includes('新しい課題')) {
    return 'newAssignment';
  }

  if (headText.includes('新しいお知らせ')) {
    return 'newAnnouncement';
  }

  return 'other';
}

function isTaskRelatedRow_(row) {
  const source = String(row[2] || '');
  const dueStatus = String(row[6] || '');
  const status = String(row[12] || '');
  const subject = String(row[7] || '');
  const body = String(row[11] || '');

  if (isClassroomExtensionSyncRow_(row)) {
    return false;
  }

  if (
    dueStatus === '提出記録' ||
    status === '完了記録'
  ) {
    return false;
  }

  if (source !== 'Google Classroom' && source !== 'inCampus') {
    return false;
  }

  if (source === 'Google Classroom') {
    const notificationType = getClassroomNotificationType_(body);

    return notificationType === 'newAssignment';
  }

  return getInCampusMailKind_(body) === 'assignment';
}

function isClassroomExtensionSyncRow_(row) {
  const source = String(row[2] || '');

  if (source !== 'Google Classroom') {
    return false;
  }

  const messageId = String(row[1] || '');
  const dueStatus = String(row[6] || '');
  const subject = String(row[7] || '');
  const from = String(row[8] || '');

  return from === 'Google Classroom同期' ||
    subject.startsWith('Classroom完了同期:') ||
    subject.startsWith('Classroom期限同期:') ||
    (messageId.startsWith('classroom:') && dueStatus.startsWith('Classroomで'));
}

function isNonActionableNotification_(text) {
  const normalizedText = String(text || '').replace(/\s+/g, '');
  const gradeKeywords = [
    '採点済み',
    '採点しました',
    '課題を採点',
    '成績:',
    '成績：',
    '成績を表示',
    '採点結果',
    '返却されました',
    '評価を返却'
  ];

  return gradeKeywords.some(keyword => normalizedText.includes(keyword));
}

function formatDateForWeb_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy/MM/dd HH:mm'
    );
  }

  return String(value || '');
}

function normalizeDueInfoForWeb_(dueDateValue, dueStatusValue) {
  const dueStatus = String(dueStatusValue || '');
  const rawText = String(dueDateValue || '').trim();

  if (
    rawText === '期限なし' ||
    dueStatus.includes('期限なし')
  ) {
    return {
      dueDate: '期限なし',
      dueDateKey: '',
      dueTime: '',
      dueType: 'none'
    };
  }

  if (
    rawText === '' ||
    rawText === '期限未検出' ||
    dueStatus.includes('未検出')
  ) {
    return {
      dueDate: '期限未検出',
      dueDateKey: '',
      dueTime: '',
      dueType: 'unknown'
    };
  }

  if (dueDateValue instanceof Date) {
    const year = dueDateValue.getFullYear();
    const month = dueDateValue.getMonth() + 1;
    const day = dueDateValue.getDate();
    const hour = dueDateValue.getHours();
    const minute = dueDateValue.getMinutes();
    const hasTime = hour !== 0 || minute !== 0 || /Classroomで時刻補正|拡張機能で抽出|時刻あり/.test(dueStatus);

    return buildNormalizedDueInfo_(
      year,
      month,
      day,
      hasTime ? `${hour}:${minute}` : ''
    );
  }

  const parsed = parseDueDateTextForWeb_(rawText);

  if (parsed) {
    return parsed;
  }

  return {
    dueDate: '期限未検出',
    dueDateKey: '',
    dueTime: '',
    dueType: 'unknown'
  };
}

function parseDueDateTextForWeb_(text) {
  let match;

  match = String(text).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    return buildNormalizedDueInfo_(match[1], match[2], match[3], match[4]);
  }

  match = String(text).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    return buildNormalizedDueInfo_(match[1], match[2], match[3], match[4]);
  }

  match = String(text).match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    return buildNormalizedDueInfo_(match[1], match[2], match[3], match[4]);
  }

  match = String(text).match(/^(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    const year = new Date().getFullYear();
    return buildNormalizedDueInfo_(year, match[1], match[2], match[3]);
  }

  return null;
}

function buildNormalizedDueInfo_(year, month, day, timeText) {
  let yearNum = Number(year);
  let monthNum = Number(month);
  let dayNum = Number(day);

  if (!isValidDateParts_(yearNum, monthNum, dayNum)) {
    return {
      dueDate: '期限未検出',
      dueDateKey: '',
      dueTime: '',
      dueType: 'unknown'
    };
  }

  let time = normalizeTimeText_(timeText);
  if (time === '00:00') {
    const priorDay = new Date(yearNum, monthNum - 1, dayNum - 1);
    yearNum = priorDay.getFullYear(); monthNum = priorDay.getMonth() + 1; dayNum = priorDay.getDate();
    time = '23:59';
  }
  const y = String(yearNum);
  const m = String(monthNum).padStart(2, '0');
  const d = String(dayNum).padStart(2, '0');

  return {
    dueDate: time ? `${y}/${m}/${d} ${time}` : `${y}/${m}/${d}`,
    dueDateKey: `${y}-${m}-${d}`,
    dueTime: time,
    dueType: 'detected'
  };
}

function isValidDateParts_(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  if (month < 1 || month > 12) {
    return false;
  }

  if (day < 1 || day > 31) {
    return false;
  }

  const date = new Date(year, month - 1, day);

  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
}

function normalizeTimeText_(timeText) {
  if (!timeText) {
    return '';
  }

  const parts = String(timeText).split(':');

  if (parts.length !== 2) {
    return '';
  }

  const hour = Number(parts[0]);
  const minute = Number(parts[1]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return '';
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function refreshAndGetNotificationsForWeb() {
  // Gmail scanning can take much longer than a sheet read. The ingestion
  // function now locks only its setup/commit phases, so this request must not
  // wrap the full scan in another user lock.
  saveClassroomMailsToSheet();
  return getNotificationsForWeb();
}

function syncAndGetNotificationsForWeb() {
  // Test mode changes only which sheet is displayed. Gmail mail is still
  // committed to the signed-in user's original private spreadsheet.
  const syncResult = saveClassroomMailsToSheet();
  return {
    items: getNotificationsForWeb(),
    testCaseModeEnabled: isTestCaseModeEnabled_(),
    syncSkipped: Boolean(syncResult.skipped),
    syncSkipReason: String(syncResult.reason || ''),
    savedCount: Number(syncResult.savedCount || 0),
    classroomSavedCount: Number(syncResult.classroomSavedCount || 0),
    inCampusSavedCount: Number(syncResult.inCampusSavedCount || 0),
    autoCompletedCount: Number(syncResult.autoCompletedCount || 0),
    completedAt: new Date().toISOString()
  };
}

function clearNotificationSheetData_() {
  return runWithUserLock_('保存データ処理', () => clearNotificationSheetDataLocked_());
}

function clearNotificationSheetDataLocked_() {
  if (isTestCaseModeEnabled_()) {
    throw new Error('テストケース適用中はテストデータを消去できません。設定をOFFにしてから実行してください。');
  }
  const ss = getOrCreateSpreadsheet_();
  const sheetsBySource = ensureNotificationStorage_(ss);

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() <= 1) {
      return;
    }

    sheet
      .getRange(2, 1, sheet.getLastRow() - 1, HEADER_ROW.length)
      .clearContent();
  });

  SpreadsheetApp.flush();
}

function rebuildAndGetNotificationsForWeb() {
  // Kept as a compatibility endpoint; rebuilding by clearing the workbook
  // would force an unnecessary wide Gmail scan. Reuse the normal watermark.
  saveClassroomMailsToSheet();
  return getNotificationsForWeb();
}

function rebuildAndGetNotificationsForWebLocked_() {
  throw new Error('増分同期は共有ロックの外側から実行してください。');
}

function ensureAutoFetchTrigger_() {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === AUTO_FETCH_HANDLER);
  const props = PropertiesService.getUserProperties();
  const configuredRevision = props.getProperty(AUTO_FETCH_TRIGGER_REVISION_PROPERTY);

  if (matchingTriggers.length > 0 && configuredRevision === AUTO_FETCH_TRIGGER_REVISION) {
    matchingTriggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));

    return {
      created: false,
      removedDuplicates: Math.max(0, matchingTriggers.length - 1)
    };
  }

  // Existing triggers can remain pinned to an older code version. Create the
  // replacement first so a creation error never leaves the user without sync.
  const replacement = ScriptApp.newTrigger(AUTO_FETCH_HANDLER)
    .timeBased()
    .everyMinutes(15)
    .create();
  matchingTriggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  props.setProperty(AUTO_FETCH_TRIGGER_REVISION_PROPERTY, AUTO_FETCH_TRIGGER_REVISION);

  return {
    created: true,
    replacedExisting: matchingTriggers.length > 0,
    removedDuplicates: Math.max(0, matchingTriggers.length - 1),
    replacementId: replacement.getUniqueId ? replacement.getUniqueId() : ''
  };
}

function setupAutoFetchTrigger() {
  return runWithUserLock_('保存データ処理', () => setupAutoFetchTriggerLocked_());
}

function setupAutoFetchTriggerLocked_() {
  const result = ensureAutoFetchTrigger_();

  Logger.log(result.created
    ? '15分ごとの自動取得トリガーを作成しました。'
    : '自動取得トリガーは設定済みです。');

  return result;
}

function deleteAutoFetchTrigger() {
  return runWithUserLock_('保存データ処理', () => deleteAutoFetchTriggerLocked_());
}

function deleteAutoFetchTriggerLocked_() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === AUTO_FETCH_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  Logger.log('自動取得トリガーを削除しました。');
}

function markNotificationDone(messageId) {
  return updateNotificationStatus_(messageId, '完了', getNotificationsForWeb);
}

function markNotificationUndone(messageId) {
  return updateNotificationStatus_(messageId, '未確認', getCompletedNotificationsForWeb);
}

function updateNotificationStatus_(messageId, status, responseBuilder) {
  return runWithUserLock_('保存データ処理', () => updateNotificationStatusLocked_(messageId, status, responseBuilder));
}

function updateNotificationStatusLocked_(messageId, status, responseBuilder) {
  const targetMessageId = String(messageId || '');

  if (!targetMessageId) {
    return responseBuilder();
  }

  if (isTestCaseModeEnabled_()) {
    saveTestNotificationState_(targetMessageId, status);
    return responseBuilder();
  }

  if (targetMessageId.startsWith('incampus:')) {
    updateInCampusExtractedStatus_(targetMessageId, status);
    return responseBuilder();
  }

  const ss = getOrCreateSpreadsheet_();
  const sheetsBySource = ensureNotificationStorage_(ss);
  let updated = false;

  for (const storageConfig of NOTIFICATION_STORAGE_CONFIGS) {
    const sheet = sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() < 2) {
      continue;
    }

    const values = sheet.getDataRange().getValues();
    const logicalTarget = findInCampusLogicalRecordById_(values, targetMessageId);
    if (logicalTarget) {
      setInCampusLogicalRecordStatus_(sheet, values, logicalTarget, status, new Date());
      updated = true;
      break;
    }

    for (let i = 1; i < values.length; i++) {
      const rowMessageId = String(values[i][1] || '');

      if (rowMessageId !== targetMessageId) {
        continue;
      }

      if (storageConfig.source === 'inCampus') {
        const records = extractInCampusMailRecords_(values[i][7], values[i][11], values[i][9]);
        const child = expandInCampusNotificationRow_(values[i])[getLegacyInCampusRecordIndex_(values[i], records)];
        if (child) {
          setInCampusLogicalRecordStatus_(sheet, values, {index: i, row: child}, status, new Date());
          updated = true;
          break;
        }
      }
      const sheetRow = i + 1;
      sheet.getRange(sheetRow, 13).setValue(status);

      if (status === '完了') {
        sheet.getRange(sheetRow, 14).setValue(new Date());
      } else {
        sheet.getRange(sheetRow, 14).clearContent();
      }

      SpreadsheetApp.flush();
      updated = true;
      break;
    }

    if (updated) {
      break;
    }
  }

  return responseBuilder();
}

function cleanBodyForWeb_(body, source) {
  const rawText = String(body || '');

  if (source === 'Google Classroom') {
    return cleanClassroomBodyForWeb_(rawText);
  }

  return cleanCommonEmailBodyForWeb_(rawText);
}

function cleanClassroomBodyForWeb_(body) {
  const text = removeEmailFooterForWeb_(body);
  const lines = getCleanLines_(text);

  const cleanedLines = lines.filter(line => {
    const currentLine = String(line || '').trim();

    if (currentLine === '') {
      return false;
    }

    if (isClassroomUrlOrWrappedUrlLine_(currentLine)) {
      return false;
    }

    if (currentLine === '通知設定') {
      return false;
    }

    if (currentLine === '詳細を表示') {
      return false;
    }

    if (currentLine === '課題を表示') {
      return false;
    }

    if (currentLine === '成績を表示') {
      return false;
    }

    if (currentLine === '返信') {
      return false;
    }

    if (currentLine.includes('Google LLC')) {
      return false;
    }

    if (currentLine.includes('このメールは、Google Classroom')) {
      return false;
    }

    if (currentLine.includes('配信停止')) {
      return false;
    }

    if (currentLine.includes('設定の変更')) {
      return false;
    }

    if (currentLine.includes('accounts.google.com')) {
      return false;
    }

    return true;
  });

  return cleanedLines.join('\n');
}

function cleanCommonEmailBodyForWeb_(body) {
  return removeEmailFooterForWeb_(body).trim();
}

function removeEmailFooterForWeb_(body) {
  const text = String(body || '');

  const footerMarkers = [
    'Google LLC 1600 Amphitheatre Parkway',
    'このメールは、Google Classroom',
    '配信停止または設定の変更'
  ];

  let cutIndex = -1;

  footerMarkers.forEach(marker => {
    const index = text.indexOf(marker);

    if (index >= 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  });

  if (cutIndex >= 0) {
    return text.slice(0, cutIndex).trim();
  }

  return text.trim();
}

function rowToNotificationItem_(row) {
  const dueInfo = normalizeDueInfoForWeb_(row[5], row[6]);
  const receivedAtTime = getTimeForSort_(row[9]);
  const completedAtTime = getTimeForSort_(row[13]);
  const source = String(row[2] || '');
  const body = String(row[11] || '');

  return {
    savedAt: formatDateForWeb_(row[0]),
    messageId: row[1],
    source: row[2],
    courseName: row[3],
    title: source === 'inCampus' ? extractInCampusTitle_(row[7], body) : (row[4] && row[4] !== 'タイトル未抽出' ? row[4] : row[7]),
    weekdayPeriod: (extractRequiredInCampusFieldsFromBody_(body) || {}).weekdayPeriod || '',

    dueDate: dueInfo.dueDate,
    dueDateKey: dueInfo.dueDateKey,
    dueTime: dueInfo.dueTime,
    dueType: dueInfo.dueType,

    dueStatus: row[6],
    subject: row[7],
    from: row[8],
    receivedAt: formatDateForWeb_(row[9]),
    receivedAtTime: receivedAtTime,
    gmailLink: row[10],
    classroomUrl: extractClassroomUrl_(source, body),
    body: cleanBodyForWeb_(body, source),
    status: row[12],
    completedAt: formatDateForWeb_(row[13]),
    completedAtTime: completedAtTime
  };
}

function getActiveInCampusExtractedItemsForWeb_() {
  return getInCampusExtractedItemsForWeb_('active');
}

function getCompletedInCampusExtractedItemsForWeb_() {
  return getInCampusExtractedItemsForWeb_('completed');
}

function getInCampusExtractedItemsForWeb_(viewMode) {
  return runWithUserLock_('保存データ処理', () => getInCampusExtractedItemsForWebLocked_(viewMode));
}

function getInCampusExtractedItemsForWebLocked_(viewMode) {
  const testMode = isTestCaseModeEnabled_();
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const sheet = getInCampusReadSheet_(testSpreadsheet);

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  const headerMap = getInCampusHeaderMap_(sheet);
  const testReferenceDate = testMode ? getTestCaseReferenceNow_() : null;
  const rows = values.slice(1).map(row => testMode
    ? mapTestCaseExtractRowForRead_(row, testReferenceDate)
    : row);
  const items = rows
    .map(row => rowToInCampusExtractedItem_(row, headerMap))
    .filter(item => item.messageId)
    .map(item => applyTestNotificationStateToItem_(item, testStates));
  const submissionItems = items.filter(item => isInCampusSubmissionItemForWeb_(item));
  const assignmentItems = items.filter(item => !isInCampusSubmissionItemForWeb_(item));

  // Submission events are persisted once during ingestion; reads must respect manual undo.
  applyNotificationCompletionToInCampusExtractedItemsForWeb_(assignmentItems);

  return assignmentItems
    .filter(item => {
      if (viewMode === 'completed') {
        return item.status === '完了';
      }

      return item.status !== '完了';
    });
}

function getInCampusHeaderMap_(sheet) {
  const headerValues = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0];
  const headerMap = {};

  headerValues.forEach((header, index) => {
    const name = String(header || '').trim();

    if (name) {
      headerMap[name] = index + 1;
    }
  });

  return headerMap;
}

function getInCampusCell_(row, headerMap, headerName, fallbackIndex) {
  const column = headerMap[headerName] || 0;

  if (column > 0) {
    return row[column - 1];
  }

  if (fallbackIndex >= 0) {
    return row[fallbackIndex];
  }

  return '';
}

function hasInCampusHeader_(headerMap, headerName) {
  return Boolean(headerMap && headerMap[headerName]);
}

function rowToInCampusExtractedItem_(row, headerMap) {
  const source = String(getInCampusCell_(row, headerMap, 'source', 0) || 'inCampus');
  const rawType = String(getInCampusCell_(row, headerMap, 'type', 1) || '');
  const title = String(getInCampusCell_(row, headerMap, 'title', 2) || '');
  const body = String(getInCampusCell_(row, headerMap, 'body', 3) || '');
  const periodText = getInCampusCell_(row, headerMap, 'periodText', 6);
  const dueAtValue = getInCampusCell_(row, headerMap, 'dueAt', 5) || extractDueAtFromPeriodText_(periodText) || '';
  const hasDueAt = isPresentValue_(dueAtValue);
  const pageUrl = String(getInCampusCell_(row, headerMap, 'pageUrl', 10) || '');
  const extractedAt = getInCampusCell_(row, headerMap, 'extractedAt', 11) || getInCampusCell_(row, headerMap, 'receivedAt', 12) || '';
  const receivedAt = getInCampusCell_(row, headerMap, 'receivedAt', 12) || getInCampusCell_(row, headerMap, 'extractedAt', 11) || '';
  const raw = parseInCampusRawJson_(getInCampusCell_(row, headerMap, 'rawJson', 13));
  const status = hasInCampusHeader_(headerMap, 'status')
    ? String(getInCampusCell_(row, headerMap, 'status', -1) || '未確認')
    : String(raw.status || '未確認');
  const completedAt = hasInCampusHeader_(headerMap, 'completedAt')
    ? getInCampusCell_(row, headerMap, 'completedAt', -1)
    : raw.completedAt || '';
  const courseNameFromColumn = hasInCampusHeader_(headerMap, 'courseName')
    ? String(getInCampusCell_(row, headerMap, 'courseName', -1) || '')
    : '';
  const updateText = String(getInCampusCell_(row, headerMap, 'updateText', -1) || raw.updateText || '');
  const updateAction = String(getInCampusCell_(row, headerMap, 'updateAction', -1) || raw.updateAction || raw.action || '');
  const updateAt = getInCampusCell_(row, headerMap, 'updateAt', -1) || raw.updateAt || '';
  const dueInfo = normalizeDueInfoForWeb_(dueAtValue, hasDueAt ? '拡張機能で抽出' : '期限未検出・要確認');
  const receivedAtTime = getTimeForSort_(receivedAt || extractedAt);
  const completedAtTime = getTimeForSort_(completedAt);
  const messageId = pageUrl ? `incampus:${pageUrl}` : '';
  const detailLines = [
    body,
    periodText ? `提出期間: ${periodText}` : '',
    getInCampusCell_(row, headerMap, 'lateSubmission', 7) ? `期間外提出: ${getInCampusCell_(row, headerMap, 'lateSubmission', 7)}` : '',
    getInCampusCell_(row, headerMap, 'assignmentType', 8) ? `課題種別: ${getInCampusCell_(row, headerMap, 'assignmentType', 8)}` : '',
    getInCampusCell_(row, headerMap, 'attachment', 9) ? `添付ファイル: ${getInCampusCell_(row, headerMap, 'attachment', 9)}` : ''
  ].filter(Boolean);

  return {
    savedAt: formatDateForWeb_(extractedAt),
    messageId,
    source,
    rawType,
    assignmentKey: String(getInCampusCell_(row, headerMap, 'assignmentKey', -1) || raw.assignmentKey || ''),
    extractedAt: formatDateForWeb_(extractedAt),
    rawUpdateText: updateText,
    rawUpdateAction: updateAction,
    rawUpdateAt: updateAt,
    courseName: courseNameFromColumn || raw.courseName || 'inCampus',
    title: title || raw.title || 'タイトル未抽出',

    dueDate: dueInfo.dueDate,
    dueDateKey: dueInfo.dueDateKey,
    dueTime: dueInfo.dueTime,
    dueType: dueInfo.dueType,

    dueStatus: hasDueAt ? '拡張機能で抽出' : '期限未検出・要確認',
    subject: title || raw.title || '',
    from: 'inCampus',
    receivedAt: formatDateForWeb_(receivedAt || extractedAt),
    receivedAtTime: receivedAtTime,
    gmailLink: '',
    classroomUrl: pageUrl,
    body: detailLines.join('\n\n'),
    status,
    completedAt: formatDateForWeb_(completedAt),
    completedAtTime: completedAtTime
  };
}

function isInCampusSubmissionItemForWeb_(item) {
  if (!item) {
    return false;
  }

  if (
    item.rawType === INCAMPUS_SUBMISSION_RECORD_TYPE ||
    item.status === INCAMPUS_SUBMISSION_RECORD_STATUS
  ) {
    return true;
  }

  const updateText = String(item.rawUpdateText || '');
  const updateAction = String(item.rawUpdateAction || '').toLowerCase();

  return /提出しました|提出されました|提出済/.test(updateText) ||
    /submit|submitted|submission/.test(updateAction);
}

function applyInCampusSubmissionItemsForWeb_(assignmentItems, submissionItems) {
  submissionItems.forEach(submissionItem => {
    const record = getInCampusSubmissionRecordFromItemForWeb_(submissionItem);

    if (!record.title) {
      return;
    }

    const target = findMatchingInCampusAssignmentItem_(assignmentItems, record);

    if (!target) {
      return;
    }

    target.status = '完了';
    target.completedAt = formatDateForWeb_(record.submittedAt || submissionItem.receivedAt || new Date());
    target.completedAtTime = getTimeForSort_(record.submittedAt || submissionItem.receivedAtTime || new Date());
  });
}

function getInCampusSubmissionRecordFromItemForWeb_(item) {
  return {
    courseName: item.courseName || '',
    title: extractInCampusSubmittedItemTitle_(item.rawUpdateText) || item.title || '',
    submittedAt: item.rawUpdateAt || item.receivedAt || item.completedAt || ''
  };
}

function findMatchingInCampusAssignmentItem_(assignmentItems, record) {
  const matches = assignmentItems.filter(item => isSameInCampusAssignmentForWeb_(item, record));
  return matches.length === 1 ? matches[0] : null;
}

function isPresentValue_(value) {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  return String(value || '').trim() !== '';
}

function parseInCampusRawJson_(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function extractDueAtFromPeriodText_(periodText) {
  const parts = String(periodText || '')
    .split(/[～〜~]/)
    .map(part => String(part || '').trim())
    .filter(Boolean);

  return parts.length >= 2 ? parts[1] : '';
}

function updateInCampusExtractedStatus_(messageId, status) {
  return runWithUserLock_('保存データ処理', () => updateInCampusExtractedStatusLocked_(messageId, status));
}

function updateInCampusExtractedStatusLocked_(messageId, status) {
  const pageUrl = String(messageId || '').replace(/^incampus:/, '');

  if (!pageUrl) {
    return;
  }

  const sheet = getOrCreateInCampusSheet_();

  if (!sheet || sheet.getLastRow() < 2) {
    return;
  }

  setupInCampusHeader_(sheet);

  const headerMap = getInCampusHeaderMap_(sheet);
  const pageUrlColumn = headerMap.pageUrl || INCAMPUS_HEADERS.indexOf('pageUrl') + 1;
  const statusColumn = headerMap.status || 0;
  const completedAtColumn = headerMap.completedAt || 0;

  if (!pageUrlColumn || !statusColumn || !completedAtColumn) {
    return;
  }

  const urls = sheet.getRange(2, pageUrlColumn, sheet.getLastRow() - 1, 1).getValues();
  const existingIndex = urls.findIndex(row => String(row[0] || '') === pageUrl);

  if (existingIndex === -1) {
    return;
  }

  const rowNumber = existingIndex + 2;
  sheet.getRange(rowNumber, statusColumn).setValue(status);

  if (status === '完了') {
    sheet.getRange(rowNumber, completedAtColumn).setValue(new Date());
  } else {
    sheet.getRange(rowNumber, completedAtColumn).clearContent();
  }

  SpreadsheetApp.flush();
}

function getCompletedNotificationsForWeb() {
  return runWithUserLock_('保存データ処理', () => getCompletedNotificationsForWebLocked_());
}

function getCompletedNotificationsForWebLocked_() {
  const testMode = isTestCaseModeEnabled_();
  const deadlineReferenceNow = testMode ? getTestCaseReferenceNow_() : new Date(Date.now());
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    getCompletedNotificationItemsForWeb_(testSpreadsheet, testStates),
    getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates),
    'assignment',
    testMode
  );

  return data
    .filter(item => !isExpiredNotificationForWeb_(item, deadlineReferenceNow))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item))
    .sort((a, b) => {
      if (a.completedAtTime !== b.completedAtTime) {
        return b.completedAtTime - a.completedAtTime;
      }

      return b.receivedAtTime - a.receivedAtTime;
    });
}

function getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates) {
  return runWithUserLock_('保存データ処理', () => getInCampusSupplementItemsForWebLocked_(testSpreadsheet, testStates));
}

function getInCampusSupplementItemsForWebLocked_(testSpreadsheet, testStates) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const states = testMode ? (testStates || getTestNotificationStateMap_()) : null;
  const sheet = getInCampusReadSheet_(testSpreadsheet);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const headerMap = getInCampusHeaderMap_(sheet);
  const testReferenceDate = testMode ? getTestCaseReferenceNow_() : null;
  return sheet.getDataRange().getValues().slice(1)
    .map(row => testMode ? mapTestCaseExtractRowForRead_(row, testReferenceDate) : row)
    .map(row => rowToInCampusExtractedItem_(row, headerMap))
    .map(item => applyTestNotificationStateToItem_(item, states));
}

function normalizeInCampusExactText_(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function getInCampusCourseIdentity_(item) {
  let name = normalizeInCampusExactText_(item && item.courseName).replace(/^[\[［](.*)[\]］]$/, '$1');
  const prefix = name.match(/^([月火水木金土日])\s*(\d+)\s+/);
  let schedule = prefix ? prefix[1] + prefix[2] : '';
  if (prefix) name = name.slice(prefix[0].length);
  const period = normalizeInCampusExactText_(item && item.weekdayPeriod);
  const day = period.match(/([月火水木金土日])曜/);
  const slot = period.match(/(\d+)限/);
  if (day && slot) schedule = day[1] + slot[1];
  return {name: name.trim(), schedule};
}

function isInCampusReportDetailUrl_(value, testMode) {
  const url = String(value || '');
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  return /^https:\/\/ic\.ss\.senshu-u\.ac\.jp\/lms\/course\/report\//.test(url) ||
    (useTestMode && /^https:\/\/portal\.example\.invalid\/course\/report\/SIM-\d{4}$/.test(url));
}

function mergeNotificationAndInCampusExtractedItemsForWeb_(notificationItems, extractedItems, kind, testMode) {
  const expectedKind = kind || 'assignment';
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  return notificationItems.map(notification => {
    if (notification.source !== 'inCampus') return notification;
    const candidates = extractedItems.filter(item => {
      const itemKind = item.rawUpdateText ? getInCampusUpdateKind_(item.rawUpdateText) : item.rawType;
      if (itemKind !== expectedKind || item.rawType === 'submissionRecord') return false;
      if (expectedKind === 'assignment' && !isInCampusReportDetailUrl_(item.classroomUrl, useTestMode)) return false;
      return isSameInCampusAssignmentForWeb_(notification, item);
    });
    // Updates of the same report are one candidate; different reports are ambiguous.
    const identities = new Set(candidates.map(item => expectedKind === 'assignment'
      ? item.classroomUrl : item.assignmentKey || item.classroomUrl));
    if (identities.size !== 1 || !candidates.length) return notification;
    const supplement = candidates.slice().sort((a,b) => b.receivedAtTime - a.receivedAtTime)[0];
    const result = Object.assign({}, notification, {
      supplementKey: supplement.assignmentKey || supplement.classroomUrl,
      supplementUpdatedAt: supplement.extractedAt || supplement.receivedAt
    });
    if (expectedKind === 'assignment') {
      if (supplement.dueType === 'detected') {
        ['dueDate','dueDateKey','dueTime','dueType','dueStatus'].forEach(key => result[key] = supplement[key]);
      }
      result.classroomUrl = supplement.classroomUrl;
      if (supplement.body) result.body = [notification.body, '【inCampusからの補足】', supplement.body].filter(Boolean).join('\n\n');
    }
    if (expectedKind === 'announcement' && supplement.rawUpdateText) {
      result.body = [notification.body, '【inCampusの更新通知】', supplement.rawUpdateText].filter(Boolean).join('\n\n');
    }
    // Mail message ID, received date, title, course, status and Gmail link remain authoritative.
    return result;
  });
}

function enrichInCampusExtractedItemsFromNotificationItemsForWeb_(notificationItems, extractedItems) {
  notificationItems
    .filter(item => String(item.source || '') === 'inCampus')
    .forEach(notificationItem => {
      const notificationCourseName = normalizeInCampusCourseNameForMatch_(notificationItem.courseName);

      if (isGenericInCampusCourseNameForMatch_(notificationCourseName)) {
        return;
      }

      const target = extractedItems.find(extractedItem => isSameInCampusAssignmentForWeb_(notificationItem, extractedItem));

      if (!target) {
        return;
      }

      const targetCourseName = normalizeInCampusCourseNameForMatch_(target.courseName);

      if (isGenericInCampusCourseNameForMatch_(targetCourseName)) {
        target.courseName = notificationItem.courseName;
      }
    });
}

function applyNotificationCompletionToInCampusExtractedItemsForWeb_(assignmentItems) {
  const completedNotificationItems = getCompletedNotificationItemsForWeb_()
    .filter(item => String(item.source || '') === 'inCampus');

  completedNotificationItems.forEach(completedItem => {
    const target = assignmentItems.find(item => isSameInCampusAssignmentForWeb_(completedItem, item));

    if (!target) {
      return;
    }

    target.status = '完了';
    target.completedAt = completedItem.completedAt || completedItem.receivedAt || '';
    target.completedAtTime = completedItem.completedAtTime || completedItem.receivedAtTime || 0;
  });
}

function isSameInCampusAssignmentForWeb_(a, b) {
  const titleA = normalizeInCampusExactText_(a && a.title);
  const titleB = normalizeInCampusExactText_(b && b.title);
  const courseA = getInCampusCourseIdentity_(a);
  const courseB = getInCampusCourseIdentity_(b);
  if (!titleA || !titleB || !courseA.name || !courseB.name) return false;
  if (isGenericInCampusCourseNameForMatch_(courseA.name.toLowerCase()) || isGenericInCampusCourseNameForMatch_(courseB.name.toLowerCase())) return false;
  if (courseA.schedule && courseB.schedule && courseA.schedule !== courseB.schedule) return false;
  return titleA === titleB && courseA.name === courseB.name;
}

function isGenericInCampusCourseNameForMatch_(courseName) {
  const text = String(courseName || '');

  return text === '' ||
    text === 'incampus' ||
    text === 'incampusお知らせ';
}

function getCompletedNotificationItemsForWeb_(testSpreadsheet, testStates) {
  return runWithUserLock_('保存データ処理', () => getCompletedNotificationItemsForWebLocked_(testSpreadsheet, testStates));
}

function getCompletedNotificationItemsForWebLocked_(testSpreadsheet, testStates) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const sheetsBySource = getNotificationReadSheets_(testSpreadsheet);
  let rows = getNotificationRowsFromSheets_(sheetsBySource, testMode);
  applyTestNotificationStatesToRows_(rows, testStates);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') === '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
}

function debugNotificationSheet() {
  return runWithUserLock_('保存データ処理', () => debugNotificationSheetLocked_());
}

function debugNotificationSheetLocked_() {
  const ss = getOrCreateSpreadsheet_();
  const sheetsBySource = ensureNotificationStorage_(ss);

  Logger.log('スプレッドシートURL: ' + ss.getUrl());

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource[storageConfig.source];
    const dataRowCount = Math.max(0, sheet.getLastRow() - 1);

    Logger.log('シート名: ' + sheet.getName());
    Logger.log('シートID: ' + sheet.getSheetId());
    Logger.log('データ行数: ' + dataRowCount);
  });
}

function debugWebData() {
  const data = getNotificationsForWeb();

  Logger.log('Web表示件数: ' + data.length);

  data.slice(0, 10).forEach((item, index) => {
    Logger.log(JSON.stringify({
      index: index + 1,
      source: item.source,
      courseName: item.courseName,
      title: item.title,
      dueDate: item.dueDate,
      dueDateKey: item.dueDateKey,
      dueTime: item.dueTime,
      dueType: item.dueType,
      dueStatus: item.dueStatus,
      receivedAt: item.receivedAt
    }, null, 2));
  });
}

function debugDueDateExtraction() {
  const samples = [
    '提出期限：2026/07/01 23:59',
    '期限 2026年6月26日',
    '期限 6月26日 23:59',
    '7/1 23:59',
    '成績: 100/100',
    '明日まで',
    '今週金曜まで',
    '期限なし'
  ];

  samples.forEach(sample => {
    Logger.log(JSON.stringify({
      input: sample,
      result: extractDueDate_(sample, new Date())
    }, null, 2));
  });
}

function rebuildNotificationsManually() {
  const data = rebuildAndGetNotificationsForWeb();

  Logger.log('増分同期が完了しました。表示対象件数: ' + data.length);
}

const INCAMPUS_SHEET_NAME = 'inCampus抽出';
const INCAMPUS_SUBMISSION_RECORD_TYPE = 'submissionRecord';
const INCAMPUS_SUBMISSION_RECORD_STATUS = '完了記録';

// 配布時は空文字のままにし、Webアプリは「アクセスしているユーザーとして実行」でデプロイする。
// Webアプリを「自分として実行」で共有すると、保存先とUserPropertiesは所有者側に集約される。
// 管理者が単一シートへ集約したい場合だけ、明示的にIDを入れる。
const DEFAULT_SPREADSHEET_ID = '';
const USER_SPREADSHEET_ID_PROPERTY = 'TASKHUB_SPREADSHEET_ID';
const LEGACY_SPREADSHEET_ID_PROPERTY = 'SPREADSHEET_ID';
const TEST_CASE_MODE_PROPERTY = 'TASKHUB_TEST_CASE_MODE';
const TEST_CASE_CLOCK_PROPERTY = 'TASKHUB_TEST_CASE_CLOCK';
const TEST_SPREADSHEET_ID_PROPERTY = 'TASKHUB_TEST_SPREADSHEET_ID';
const DEFAULT_TEST_SPREADSHEET_ID = '1ZVGwBnMrXaOMJ-D1SqeFuL-nVndXqwEIp55Gm5cTtuQ';
const TEST_NOTIFICATION_STATE_PROPERTY_PREFIX = 'TASKHUB_TEST_NOTIFICATION_STATE:';
const TEST_CASE_CLOCK_PRESETS = [
  {id: 'saturday', label: '2026/12/26（土）09:00 — 土曜、日曜期限は明日', dateTime: '2026-12-26T09:00'},
  {id: 'sunday', label: '2026/12/27（日）23:58 — 日曜から月曜への週境界', dateTime: '2026-12-27T23:58'},
  {id: 'weekday', label: '2026/12/29（火）10:30 — 平日の4区分', dateTime: '2026-12-29T10:30'},
  {id: 'year-end', label: '2026/12/31（木）23:58 — 年越し・0:00期限', dateTime: '2026-12-31T23:58'},
  {id: 'new-year', label: '2027/01/01（金）00:01 — 年越し直後', dateTime: '2027-01-01T00:01'},
  {id: 'jst-utc-boundary', label: '2027/01/01（金）00:05 — JST/UTC年境界', dateTime: '2027-01-01T00:05'},
  {id: 'non-leap-year', label: '2027/02/28（日）09:00 — 平年、2/29は無効日付', dateTime: '2027-02-28T09:00'},
  {id: 'month-end', label: '2027/04/30（金）09:00 — 月末から5月初日', dateTime: '2027-04-30T09:00'},
  {id: 'leap-eve', label: '2028/02/28（月）09:00 — 閏日の前日', dateTime: '2028-02-28T09:00'},
  {id: 'leap-day', label: '2028/02/29（火）09:00 — 閏日当日', dateTime: '2028-02-29T09:00'}
];
const API_TOKEN_PROPERTY = 'TASKHUB_API_TOKEN';
const API_TOKEN_MIN_LENGTH = 48;
const MAX_POST_BODY_LENGTH = 200000;
const MAX_POST_RECORDS = 100;
const ALLOWED_INCAMPUS_HOST = 'ic.ss.senshu-u.ac.jp';

const ASSIGNMENT_FIELD_LIMITS = {
  source: 32,
  type: 64,
  title: 500,
  body: 5000,
  startAt: 64,
  dueAt: 64,
  periodText: 1200,
  lateSubmission: 120,
  assignmentType: 120,
  attachment: 1200,
  pageUrl: 2048,
  assignmentKey: 512,
  extractedAt: 64,
  receivedAt: 64,
  rawText: 5000,
  courseName: 500,
  updateText: 2000,
  updateAction: 128,
  updateAt: 64,
  status: 32,
  completedAt: 64
};

const CLASSROOM_RECORD_FIELD_LIMITS = {
  title: 500,
  courseName: 500,
  classroomUrl: 2048,
  pageUrl: 2048,
  completedAt: 64,
  courseId: 128,
  streamItemId: 128,
  dueText: 500,
  dueDate: 64,
  dueTime: 16,
  dueAt: 64
};

const INCAMPUS_HEADERS = [
  'source',
  'type',
  'title',
  'body',
  'startAt',
  'dueAt',
  'periodText',
  'lateSubmission',
  'assignmentType',
  'attachment',
  'pageUrl',
  'extractedAt',
  'receivedAt',
  'rawJson',
  'status',
  'completedAt',
  'assignmentKey'
];

const TEST_CASE_NOTIFICATION_HEADERS = HEADER_ROW.concat([
  'テスト保存日時', 'テスト受信日時', 'テスト期限（保存値）', 'テスト期限（アプリ表示）'
]);
const TEST_CASE_EXTRACT_HEADERS = INCAMPUS_HEADERS.concat([
  'テスト受信日時', 'テスト期限（保存値）', 'テスト期限（アプリ表示）'
]);

function doPost(e) {
  try {
    return runWithUserLock_('同期処理', () => {
    const payload = parseJsonBody_(e);
    assertValidApiToken_(payload);

    if (payload.action === 'upsertInCampusAssignment') {
      const assignment = sanitizeObjectByFieldLimits_(payload.assignment || {}, ASSIGNMENT_FIELD_LIMITS);
      validateAssignment_(assignment);

      const result = upsertInCampusAssignment_(assignment);

      return jsonResponse_({
        ok: true,
        updated: result.updated,
        row: result.row
      });
    }

    if (payload.action === 'completeClassroomAssignments') {
      const result = completeClassroomAssignments_(sanitizePostRecords_(payload.records || []));

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

function getTestCaseClockStateForWeb() {
  return {
    testCaseModeEnabled: isTestCaseModeEnabled_(),
    testCaseClockDateTime: getTestCaseClockDateTime_(),
    testCaseClockPresets: TEST_CASE_CLOCK_PRESETS.map(preset => ({...preset}))
  };
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
      if (!isTestCaseModeEnabled_()) clearTestNotificationStates_();
      props.setProperty(TEST_CASE_MODE_PROPERTY, 'true');
    } else {
      props.deleteProperty(TEST_CASE_MODE_PROPERTY);
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

function validateAssignment_(assignment) {
  if ((assignment.type || 'assignment') === 'assignment' && !isInCampusReportDetailUrl_(assignment.pageUrl)) {
    throw new Error('課題詳細ページ以外は課題として保存できません。拡張機能を更新してください。');
  }
  if (assignment.source !== 'inCampus') {
    throw new Error('sourceがinCampusではありません。');
  }

  if (!assignment.title && !assignment.body && !assignment.periodText) {
    throw new Error('課題情報が空です。');
  }

  if (!assignment.pageUrl) {
    throw new Error('pageUrlがありません。');
  }

  if (!isAllowedInCampusUrlForStorage_(assignment.pageUrl)) {
    throw new Error('pageUrlはinCampusのHTTPS URLだけ保存できます。');
  }
}

function upsertInCampusAssignment_(assignment) {
  return runWithUserLock_('保存データ処理', () => upsertInCampusAssignmentLocked_(assignment));
}

function upsertInCampusAssignmentLocked_(assignment) {
  const sheet = getOrCreateInCampusSheet_();
  const submissionRecord = extractInCampusSubmissionRecordFromAssignment_(assignment);

  if (submissionRecord) {
    return upsertInCampusSubmissionRecord_(sheet, assignment, submissionRecord);
  }

  const existingRowNumber = findExistingInCampusAssignmentRow_(sheet, assignment);

  if (existingRowNumber) {
    const existingRow = sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).getValues()[0];
    const rowValues = buildAssignmentRow_(assignment, existingRow);
    sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).setValues([rowValues]);
    applySavedInCampusExtractedSubmissionRecords_(sheet);
    return { updated: true, row: existingRowNumber };
  }

  const rowValues = buildAssignmentRow_(assignment);
  sheet.appendRow(rowValues);
  applySavedInCampusExtractedSubmissionRecords_(sheet);
  return { updated: false, row: sheet.getLastRow() };
}

function extractInCampusSubmissionRecordFromAssignment_(assignment) {
  const text = [
    assignment.title,
    assignment.body,
    assignment.periodText,
    assignment.rawText,
    assignment.updateText
  ].filter(Boolean).join('\n');
  const records = extractInCampusSubmissionRecords_(
    '',
    text,
    assignment.receivedAt || assignment.extractedAt || new Date()
  );

  if (records.length === 0) {
    return null;
  }

  const record = records[0];

  return {
    courseName: isGenericInCampusCourseNameForMatch_(normalizeInCampusCourseNameForMatch_(record.courseName)) ? assignment.courseName || '' : record.courseName,
    weekdayPeriod: record.weekdayPeriod || assignment.weekdayPeriod || '',
    title: record.title,
    submittedAt: record.submittedAt || assignment.receivedAt || assignment.extractedAt || '',
    pageUrl: assignment.pageUrl || ''
  };
}

function upsertInCampusSubmissionRecord_(sheet, assignment, record) {
  const markerAssignment = Object.assign({}, assignment, {
    type: INCAMPUS_SUBMISSION_RECORD_TYPE,
    title: record.title,
    body: assignment.body || assignment.title || '',
    pageUrl: buildInCampusSubmissionRecordPageUrl_(assignment, record),
    assignmentKey: buildInCampusSubmissionRecordAssignmentKey_(assignment, record),
    status: INCAMPUS_SUBMISSION_RECORD_STATUS,
    completedAt: record.submittedAt || assignment.receivedAt || assignment.extractedAt || ''
  });
  const existingRowNumber = findExistingInCampusAssignmentRow_(sheet, markerAssignment);

  if (existingRowNumber) {
    const existingRow = sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).getValues()[0];
    const rowValues = buildAssignmentRow_(markerAssignment, existingRow);
    sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).setValues([rowValues]);
    applySavedInCampusExtractedSubmissionRecords_(sheet);
    return { updated: true, row: existingRowNumber };
  }

  const rowValues = buildAssignmentRow_(markerAssignment);
  sheet.appendRow(rowValues);
  applySavedInCampusExtractedSubmissionRecords_(sheet);
  return { updated: false, row: sheet.getLastRow() };
}

function buildInCampusSubmissionRecordPageUrl_(assignment, record) {
  const baseUrl = assignment.pageUrl || 'incampus-submission';
  const key = [
    record.title,
    record.submittedAt,
    assignment.extractedAt,
    assignment.receivedAt
  ].filter(Boolean).join('-');

  return `${baseUrl}#submitted-${encodeURIComponent(normalizeInCampusMatchText_(key))}`;
}

function buildInCampusSubmissionRecordAssignmentKey_(assignment, record) {
  const existingKey = String(assignment.assignmentKey || '').trim();

  if (assignment.type === INCAMPUS_SUBMISSION_RECORD_TYPE && existingKey) {
    return existingKey;
  }

  const parts = [
    'inCampus',
    'submission',
    existingKey || assignment.pageUrl || '',
    record.title || assignment.title || '',
    record.submittedAt || assignment.receivedAt || assignment.extractedAt || ''
  ].filter(Boolean);

  return parts.length > 2 ? parts.join(':') : '';
}

function findExistingInCampusAssignmentRow_(sheet, assignment) {
  if (sheet.getLastRow() < 2) return 0;
  const values = sheet.getDataRange().getValues();
  const type = String(assignment.type || 'assignment');
  const key = String(assignment.assignmentKey || '').trim();
  const url = String(assignment.pageUrl || '').trim();
  for (let i = 1; i < values.length; i++) {
    const row = values[i], raw = parseInCampusRawJson_(row[13]);
    if (String(row[1] || raw.type || 'assignment') !== type) continue;
    const rowKey = String(row[16] || raw.assignmentKey || '').trim();
    if (key && rowKey === key) return i + 1;
    if (type === 'assignment' && isInCampusReportDetailUrl_(url) && String(row[10] || '') === url) return i + 1;
    if (type === 'announcement' && !key && !rowKey &&
      String(row[10] || '') === url &&
      normalizeInCampusMatchText_(row[2]) === normalizeInCampusMatchText_(assignment.title) &&
      normalizeInCampusMatchText_(raw.courseName) === normalizeInCampusMatchText_(assignment.courseName) &&
      String(raw.updateAt || '') === String(assignment.updateAt || '') &&
      String(raw.updateText || '') === String(assignment.updateText || '')) return i + 1;
  }
  return 0;
}

function applySavedInCampusExtractedSubmissionRecords_(sheet) {
  return runWithUserLock_('提出記録処理', () => applySavedInCampusExtractedSubmissionRecordsLocked_(sheet));
}

function applySavedInCampusExtractedSubmissionRecordsLocked_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getDataRange().getValues();
  let completedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[1] !== INCAMPUS_SUBMISSION_RECORD_TYPE && row[14] !== INCAMPUS_SUBMISSION_RECORD_STATUS) continue;
    const raw = parseInCampusRawJson_(row[13]);
    const record = extractInCampusSubmissionRecordFromAssignment_(raw) || {
      courseName: raw.courseName || '', weekdayPeriod: raw.weekdayPeriod || '', title: row[2],
      submittedAt: row[15] || row[12] || row[11] || '', pageUrl: raw.pageUrl || ''
    };
    const eventKey = buildInCampusSubmissionEventKey_(record, row[16], row[12]);
    const bindings = raw.appliedSubmissionTargets || {};
    const matches = findMatchingInCampusExtractedRecords_(values, record);
    const targets = bindings[eventKey] || matches.map(match => match.row[10]);
    if (!targets.length) continue;
    if (!bindings[eventKey]) {
      bindings[eventKey] = targets; raw.appliedSubmissionTargets = bindings;
      row[13] = JSON.stringify(raw); sheet.getRange(i + 1, 14).setValue(row[13]);
    }
    targets.forEach(url => {
      const index = values.findIndex((target, offset) => offset > 0 && target[1] === 'assignment' && String(target[10]) === String(url));
      if (index > 0 && setInCampusExtractedSubmissionStatus_(sheet, values, index, record, eventKey)) completedCount++;
    });
  }
  return completedCount;
}

function completeMatchingInCampusExtractedRow_(sheet, record) {
  return runWithUserLock_('提出記録処理', () => completeMatchingInCampusExtractedRowLocked_(sheet, record));
}

function completeMatchingInCampusExtractedRowLocked_(sheet, record) {
  if (!record || !record.title || !sheet || sheet.getLastRow() < 2) return false;
  const values = sheet.getDataRange().getValues();
  const eventKey = buildInCampusSubmissionEventKey_(record, '', record.submittedAt);
  let changed = false;
  findMatchingInCampusExtractedRecords_(values, record).forEach(match => {
    if (setInCampusExtractedSubmissionStatus_(sheet, values, match.index, record, eventKey)) changed = true;
  });
  return changed;
}

function findMatchingInCampusExtractedRecords_(values, record) {
  const candidates = [];
  values.slice(1).forEach((row, offset) => {
    if (String(row[1] || 'assignment') !== 'assignment') return;
    const raw = parseInCampusRawJson_(row[13]);
    const rowUrl = String(row[10] || '');
    const recordUrl = String(record.pageUrl || '');
    const exactReport = isInCampusReportDetailUrl_(recordUrl) && rowUrl === recordUrl;
    if (!exactReport && !isSameInCampusAssignmentForWeb_(record, {
      title: row[2] || raw.title, courseName: raw.courseName, weekdayPeriod: raw.weekdayPeriod
    })) return;
    candidates.push({index: offset + 1, row});
  });
  // Distinct report URLs with the same title/course cannot be resolved safely.
  return new Set(candidates.map(candidate => String(candidate.row[10]))).size > 1 ? [] : candidates;
}

function setInCampusExtractedSubmissionStatus_(sheet, values, index, record, eventKey) {
  const row = values[index];
  const raw = parseInCampusRawJson_(row[13]);
  const events = raw.appliedSubmissionEvents || {};
  if (events[eventKey]) return false;
  events[eventKey] = true; raw.appliedSubmissionEvents = events;
  row[13] = JSON.stringify(raw); row[14] = '完了'; row[15] = record.submittedAt || new Date();
  sheet.getRange(index + 1, 14, 1, 3).setValues([[row[13], row[14], toSafeSpreadsheetCell_(row[15])]]);
  return true;
}

function getOrCreateInCampusSheet_() {
  return runWithUserLock_('保存データ処理', () => getOrCreateInCampusSheetLocked_());
}

function getOrCreateInCampusSheetLocked_() {
  const ss = getTargetSpreadsheet_();
  let sheet = ss.getSheetByName(INCAMPUS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(INCAMPUS_SHEET_NAME);
  }

  setupInCampusHeader_(sheet);
  return sheet;
}

function getTargetSpreadsheet_() {
  return getOrCreateSpreadsheet_();
}

function setupInCampusHeader_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), INCAMPUS_HEADERS.length);
  const range = sheet.getRange(1, 1, 1, lastColumn);
  const current = range.getValues()[0];
  const hasExistingHeader = current.some(value => String(value || '').trim() !== '');

  if (!hasExistingHeader) {
    sheet.getRange(1, 1, 1, INCAMPUS_HEADERS.length).setValues([INCAMPUS_HEADERS]);
    sheet.getRange(1, 1, 1, INCAMPUS_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }

  const existingHeaders = new Set(current.map(value => String(value || '').trim()).filter(Boolean));
  const requiredHeaders = ['status', 'completedAt', 'assignmentKey'];

  requiredHeaders.forEach(header => {
    if (existingHeaders.has(header)) {
      return;
    }

    const nextColumn = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextColumn).setValue(header).setFontWeight('bold');
    existingHeaders.add(header);
  });

  if (sheet.getFrozenRows() < 1) {
    sheet.setFrozenRows(1);
  }
}

function buildAssignmentRow_(assignment, existingRow) {
  if (existingRow) {
    const previous = parseInCampusRawJson_(existingRow[13]);
    const merged = Object.assign({}, previous, assignment);
    ['courseName', 'weekdayPeriod', 'updateText', 'updateAction', 'updateAt', 'assignmentKey'].forEach(key => {
      if (!String(assignment[key] || '').trim()) merged[key] = previous[key] || (key === 'assignmentKey' ? existingRow[16] : '') || '';
    });
    // A detail-page manual extraction often uses its URL as a temporary key.
    if (assignment.assignmentKey === assignment.pageUrl && (previous.assignmentKey || existingRow[16])) {
      merged.assignmentKey = previous.assignmentKey || existingRow[16];
    }
    assignment = merged;
  }
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  const existingStatus = existingRow ? String(existingRow[14] || '') : '';
  const existingCompletedAt = existingRow ? existingRow[15] : '';
  const status = existingStatus || assignment.status || '未確認';
  const completedAt = status === '完了'
    ? existingCompletedAt || assignment.completedAt || now
    : '';

  return toSafeSpreadsheetRow_([
    assignment.source || 'inCampus',
    assignment.type || 'assignment',
    assignment.title || '',
    assignment.body || '',
    assignment.startAt || '',
    assignment.dueAt || '',
    assignment.periodText || '',
    assignment.lateSubmission || '',
    assignment.assignmentType || '',
    assignment.attachment || '',
    assignment.pageUrl || '',
    assignment.extractedAt || '',
    now,
    JSON.stringify(assignment),
    status,
    completedAt,
    limitText_(assignment.assignmentKey || '', ASSIGNMENT_FIELD_LIMITS.assignmentKey)
  ]);
}

function completeClassroomAssignments_(records) {
  return runWithUserLock_('保存データ処理', () => completeClassroomAssignmentsLocked_(records));
}

function completeClassroomAssignmentsLocked_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = ensureNotificationStorage_(ss)['Google Classroom'];

  if (records.length === 0) {
    return {
      foundCount: records.length,
      matchedCount: 0,
      unmatchedCount: records.length,
      results: records.map(record => buildClassroomCompletionResult_(record, false, 'Classroom通知に対象行がありません。'))
    };
  }

  const values = sheet.getDataRange().getValues();
  const results = [];
  let matchedCount = 0;
  let createdCount = 0;

  records.forEach(record => {
    const result = completeMatchingClassroomNotificationRow_(sheet, values, record);
    results.push(result);

    if (result.matched) {
      matchedCount++;
    }

    if (result.created) {
      createdCount++;
    }
  });

  SpreadsheetApp.flush();

  return {
    foundCount: records.length,
    matchedCount,
    createdCount,
    unmatchedCount: records.length - matchedCount,
    results
  };
}

function updateClassroomDueTimes_(records) {
  return runWithUserLock_('保存データ処理', () => updateClassroomDueTimesLocked_(records));
}

function updateClassroomDueTimesLocked_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = ensureNotificationStorage_(ss)['Google Classroom'];

  if (records.length === 0) {
    return {
      foundCount: records.length,
      matchedCount: 0,
      unmatchedCount: records.length,
      dueTimeCount: records.filter(record => record && record.dueTime).length,
      results: records.map(record => buildClassroomDueTimeResult_(record, false, 'Classroom通知に対象行がありません。'))
    };
  }

  const values = sheet.getDataRange().getValues();
  const results = [];
  let matchedCount = 0;
  let createdCount = 0;

  records.forEach(record => {
    const result = updateMatchingClassroomDueTimeRow_(sheet, values, record);
    results.push(result);

    if (result.matched) {
      matchedCount++;
    }

    if (result.created) {
      createdCount++;
    }
  });

  SpreadsheetApp.flush();

  return {
    foundCount: records.length,
    matchedCount,
    createdCount,
    unmatchedCount: records.length - matchedCount,
    dueTimeCount: records.filter(record => record && record.dueTime).length,
    results
  };
}

function updateMatchingClassroomDueTimeRow_(sheet, values, record) {
  const matches = findMatchingClassroomNotificationRows_(values, record, {allowTextFallback: false});
  if (!matches.length) return buildClassroomDueTimeResult_(record, false, 'Classroom通知に一致するClassroom課題がないため更新しませんでした。');
  let savedDueValue = '';
  const updatedRows = [];
  matches.forEach(match => {
    const dueValue = buildClassroomDueDateValue_(record, values[match.index][5]);
    if (!dueValue) return;
    // Strings without times retain their date-only meaning even after sync.
    const hasTime = dueValue instanceof Date || /\s\d{1,2}:\d{2}$/.test(String(dueValue));
    const status = hasTime ? 'Classroomで時刻補正' : 'Classroomで日付補正';
    sheet.getRange(match.index + 1, 6, 1, 2).setValues([[toSafeSpreadsheetCell_(dueValue), status]]);
    values[match.index][5] = dueValue; values[match.index][6] = status;
    savedDueValue = dueValue; updatedRows.push(match.index + 1);
  });
  const result = buildClassroomDueTimeResult_(record, updatedRows.length > 0, updatedRows.length ? '' : '更新できる期限情報がありません。', updatedRows[0], savedDueValue);
  result.rows = updatedRows;
  return result;
}

function buildClassroomSyntheticMessageId_(record) {
  const ids = getClassroomRecordIds_(record);

  if (ids.coursePathId && ids.itemPathId) {
    return `classroom:${ids.coursePathId}:${ids.itemPathId}`;
  }

  const classroomUrl = normalizeClassroomUrlForMatch_(record.classroomUrl || record.pageUrl);

  if (classroomUrl) {
    return `classroom:${classroomUrl}`;
  }

  return [
    'classroom',
    normalizeInCampusMatchText_(record.courseName),
    normalizeInCampusMatchText_(record.title)
  ].filter(Boolean).join(':');
}

function findMatchingClassroomNotificationRows_(values, record, options) {
  const allowTextFallback = !(options && options.allowTextFallback === false);
  const recordUrl = normalizeClassroomUrlForMatch_(record.classroomUrl || record.pageUrl);
  const recordIds = getClassroomRecordIds_(record);
  const recordTitle = normalizeInCampusMatchText_(record.title);
  const recordCourseName = normalizeClassroomCourseNameForMatch_(record.courseName);
  const recordSyntheticMessageId = buildClassroomSyntheticMessageId_(record);
  const matches = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const source = String(row[2] || '');

    if (source !== 'Google Classroom') {
      continue;
    }

    if (!isTaskRelatedRow_(row)) {
      continue;
    }

    const rowBody = String(row[11] || '');
    const rowUrl = normalizeClassroomUrlForMatch_(extractClassroomUrl_(source, rowBody));
    const rowIds = getClassroomRowIds_(row, rowUrl);
    const rowTitle = normalizeInCampusMatchText_(row[4] || row[7]);
    const rowCourseName = normalizeClassroomCourseNameForMatch_(row[3]);
    const syntheticMessageIdMatches = recordSyntheticMessageId &&
      recordSyntheticMessageId === String(row[1] || '').trim();
    const urlMatches = recordUrl && rowUrl && recordUrl === rowUrl;
    const pathIdMatches = recordIds.coursePathId &&
      recordIds.itemPathId &&
      recordIds.coursePathId === rowIds.coursePathId &&
      recordIds.itemPathId === rowIds.itemPathId;
    const exactTitleMatches = recordTitle &&
      rowTitle &&
      recordTitle === rowTitle;
    const exactCourseMatches = recordCourseName &&
      rowCourseName &&
      recordCourseName === rowCourseName;
    const titleMatches = recordTitle &&
      rowTitle &&
      (recordTitle === rowTitle ||
      rowTitle.includes(recordTitle) ||
      recordTitle.includes(rowTitle));
    const relatedCourseMatches = recordCourseName &&
      rowCourseName &&
      (recordCourseName === rowCourseName ||
      rowCourseName.includes(recordCourseName) ||
      recordCourseName.includes(rowCourseName));

    if (
      syntheticMessageIdMatches ||
      urlMatches ||
      pathIdMatches ||
      (allowTextFallback && exactTitleMatches && exactCourseMatches) ||
      (allowTextFallback && titleMatches && relatedCourseMatches)
    ) {
      matches.push({index: i, row});
    }
  }
  return matches;
}

function findMatchingClassroomNotificationRow_(values, record, options) {
  return findMatchingClassroomNotificationRows_(values, record, options)[0] || null;
}

function normalizeClassroomCourseNameForMatch_(value) {
  return normalizeInCampusMatchText_(value)
    .replace(/20\d{2}[_-]?(?:前|後|通年|春|夏|秋|冬)?[_-]?(?:月|火|水|木|金|土|日)?\d*$/g, '');
}

function getClassroomRecordIds_(record) {
  const urlIds = extractClassroomPathIds_(record && (record.classroomUrl || record.pageUrl));

  return {
    coursePathId: urlIds.coursePathId || String(record && record.courseId || '').trim(),
    itemPathId: urlIds.itemPathId || String(record && record.streamItemId || '').trim()
  };
}

function getClassroomRowIds_(row, rowUrl) {
  const urlIds = extractClassroomPathIds_(rowUrl);
  const bodyIds = extractClassroomIdsFromText_(row && row[11]);

  return {
    coursePathId: urlIds.coursePathId || bodyIds.coursePathId,
    itemPathId: urlIds.itemPathId || bodyIds.itemPathId
  };
}

function extractClassroomIdsFromText_(text) {
  const value = String(text || '');
  const courseMatch = value.match(/(?:courseId|course-id|data-course-id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  const itemMatch = value.match(/(?:streamItemId|stream-item-id|data-stream-item-id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);

  return {
    coursePathId: courseMatch ? courseMatch[1] : '',
    itemPathId: itemMatch ? itemMatch[1] : ''
  };
}

function buildClassroomDueDateValue_(record, existingDueValue) {
  const dueTime = normalizeTimeText_(record.dueTime);
  const dueAtText = String(record.dueAt || '').trim();
  const dateOnlyAt = dueAtText.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (dateOnlyAt && isValidDateParts_(Number(dateOnlyAt[1]), Number(dateOnlyAt[2]), Number(dateOnlyAt[3]))) {
    return dueTime ? buildDateWithTime_(dateOnlyAt[1], dateOnlyAt[2], dateOnlyAt[3], dueTime)
      : formatDueDate_(dateOnlyAt[1], dateOnlyAt[2], dateOnlyAt[3], '');
  }
  const dueAtDate = !dateOnlyAt ? parseClassroomDate_(record.dueAt) : null;
  if (dueAtDate) return dueAtDate;

  const dueDateText = String(record.dueDate || '').trim();
  const provided = dueDateText.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (provided && isValidDateParts_(Number(provided[1]), Number(provided[2]), Number(provided[3]))) {
    return dueTime ? buildDateWithTime_(provided[1], provided[2], provided[3], dueTime)
      : formatDueDate_(provided[1], provided[2], provided[3], '');
  }
  // Date-only pages omit today's date. Preserve the ORIGINAL date stored in the
  // sheet here, not the prior-day presentation of a known midnight deadline.
  const existing = getOriginalDueDateParts_(existingDueValue);
  if (existing && dueTime) return buildDateWithTime_(existing.year, existing.month, existing.day, dueTime);
  if (record.dueText) {
    const parsed = parseDueDateTextForWeb_(String(record.dueText).trim());
    if (parsed && parsed.dueType === 'detected') return String(record.dueText).trim();
  }
  return '';
}

function getOriginalDueDateParts_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate()};
  }
  const match = String(value || '').match(/^(\d{4})[\/年-]\s*(\d{1,2})[\/月-]\s*(\d{1,2})(?:日|\s|$)/);
  if (!match || !isValidDateParts_(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3])};
}

function parseClassroomDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (!value) {
    return null;
  }

  const explicitDate = String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T|\s|$)/);
  if (explicitDate && !isValidDateParts_(Number(explicitDate[1]), Number(explicitDate[2]), Number(explicitDate[3]))) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function buildDateWithTime_(year, month, day, timeText) {
  const time = normalizeTimeText_(timeText);
  const parts = time.split(':');

  if (parts.length !== 2) {
    return '';
  }

  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(parts[0]), Number(parts[1]), 0);

  return isNaN(date.getTime()) ? '' : date;
}

function buildClassroomDueTimeResult_(record, matched, reason, row, dueValue, created) {
  return {
    matched: Boolean(matched),
    created: Boolean(created),
    row: row || '',
    reason: reason || '',
    title: record && record.title || '',
    courseName: record && record.courseName || '',
    classroomUrl: record && (record.classroomUrl || record.pageUrl) || '',
    courseId: record && record.courseId || '',
    streamItemId: record && record.streamItemId || '',
    dueText: record && record.dueText || '',
    dueDate: record && record.dueDate || '',
    dueTime: record && record.dueTime || '',
    savedDueValue: dueValue ? formatDateForDebug_(dueValue) : ''
  };
}

function formatDateForDebug_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  }

  return String(value || '');
}

function completeMatchingClassroomNotificationRow_(sheet, values, record) {
  const matches = findMatchingClassroomNotificationRows_(values, record, {allowTextFallback: false});
  if (!matches.length) return buildClassroomCompletionResult_(record, false, 'Classroom通知に一致するClassroom課題がないため完了にしませんでした。');
  const providedCompletedAt = parseClassroomDate_(record && record.completedAt);
  const existingCompletedAt = matches.map(match => parseClassroomDate_(values[match.index][13])).find(Boolean);
  const completedAt = providedCompletedAt || existingCompletedAt || new Date();
  matches.forEach(match => {
    sheet.getRange(match.index + 1, 13, 1, 2).setValues([['完了', completedAt]]);
    values[match.index][12] = '完了'; values[match.index][13] = completedAt;
  });
  const result = buildClassroomCompletionResult_(record, true, '', matches[0].index + 1);
  result.rows = matches.map(match => match.index + 1);
  return result;
}

function buildClassroomCompletionResult_(record, matched, reason, row, created) {
  return {
    matched: Boolean(matched),
    created: Boolean(created),
    row: row || '',
    reason: reason || '',
    title: record && record.title || '',
    courseName: record && record.courseName || '',
    classroomUrl: record && (record.classroomUrl || record.pageUrl) || '',
    courseId: record && record.courseId || '',
    streamItemId: record && record.streamItemId || ''
  };
}

function normalizeClassroomUrlForMatch_(value) {
  let text = String(value || '').trim();

  if (!text) {
    return '';
  }

  text = text.replace(/&amp;/g, '&').replace(/^<|>$/g, '');

  for (let i = 0; i < 3; i++) {
    const continueMatch = text.match(/[?&]continue=([^&\s<>]+)/);

    if (!continueMatch || !continueMatch[1]) {
      break;
    }

    text = decodeUrlTextForClassroom_(continueMatch[1]);
  }

  if (!text.includes('classroom.google.com') && text.includes('%')) {
    text = decodeUrlTextForClassroom_(text);
  }

  const classroomMatch = text.match(/(?:https?:\/\/classroom\.google\.com|\/c\/)[^\s<>"']*/);

  if (!classroomMatch) {
    return '';
  }

  text = classroomMatch[0]
    .replace(/[、。]+$/g, '')
    .trim();

  if (text.startsWith('/')) {
    text = 'https://classroom.google.com' + text;
  }

  const urlMatch = text.match(/^https?:\/\/classroom\.google\.com([^?#]*)/);

  if (!urlMatch || !urlMatch[1]) {
    return '';
  }

  const normalizedPath = urlMatch[1].replace(/\/+$/, '');
  const pathMatch = normalizedPath.match(/\/c\/([^/]+)\/(?:a|m)\/([^/]+)(?:\/details)?$/);

  if (pathMatch) {
    return `https://classroom.google.com/c/${pathMatch[1]}/a/${pathMatch[2]}/details`;
  }

  return `https://classroom.google.com${normalizedPath}`;
}

function extractClassroomPathIds_(classroomUrl) {
  const normalizedUrl = normalizeClassroomUrlForMatch_(classroomUrl);
  const match = normalizedUrl.match(/\/c\/([^/]+)\/(?:a|m)\/([^/]+)(?:\/details)?$/);

  if (!match) {
    return {
      coursePathId: '',
      itemPathId: ''
    };
  }

  return {
    coursePathId: match[1],
    itemPathId: match[2]
  };
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
