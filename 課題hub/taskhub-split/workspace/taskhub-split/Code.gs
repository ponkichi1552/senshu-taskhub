const CONFIG = {
  LEGACY_SHEET_NAME: '通知一覧',
  CLASSROOM_SHEET_NAME: 'Classroom通知',
  SUPPLEMENTARY_SHEET_NAME: '補足通知',
  CLASSROOM_COURSES_SHEET_NAME: '授業',
  CLASSROOM_COURSEWORK_SHEET_NAME: 'Classroom課題',
  CLASSROOM_SUBMISSIONS_SHEET_NAME: '提出状況',
  INCAMPUS_NOTIFICATION_SHEET_NAME: 'inCampus通知',
  NOTIFICATION_RETENTION_MONTHS: 2,
  BODY_LIMIT: 5000
};

const NOTIFICATION_STORAGE_CONFIGS = [
  {
    source: 'Google Classroom',
    sheetName: CONFIG.SUPPLEMENTARY_SHEET_NAME,
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
const AUTO_FETCH_TRIGGER_REVISION = 'production-api-rollout-2026-10-05';
const AUTO_FETCH_TRIGGER_REVISION_PROPERTY = 'TASKHUB_AUTO_FETCH_TRIGGER_REVISION';
const CLASSROOM_API_TRIGGER_HANDLER = 'syncClassroomApiCourseworkOnSchedule_';
const CLASSROOM_API_TRIGGER_REVISION = 'hourly-coursework-2026-10-05';
const CLASSROOM_API_TRIGGER_REVISION_PROPERTY = 'TASKHUB_CLASSROOM_API_TRIGGER_REVISION';
const CLASSROOM_API_LAST_SUCCESS_PROPERTY = 'TASKHUB_CLASSROOM_API_LAST_SUCCESS_AT';
const CLASSROOM_API_LAST_ERROR_PROPERTY = 'TASKHUB_CLASSROOM_API_LAST_ERROR';
const CLASSROOM_API_STRUCTURED_SYNC_PROPERTY = 'TASKHUB_CLASSROOM_API_STRUCTURED_SYNC_AT';
const CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY = 'TASKHUB_CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS';
const LEGACY_CLASSROOM_NOTICE_MIGRATION_PROPERTY = 'TASKHUB_LEGACY_CLASSROOM_NOTICE_MIGRATION';
const LEGACY_NOTIFICATION_MIGRATION_PROPERTY = 'TASKHUB_LEGACY_NOTIFICATION_MIGRATION';
const LEGACY_INCAMPUS_EXTRACT_MIGRATION_PROPERTY = 'TASKHUB_LEGACY_INCAMPUS_EXTRACT_MIGRATION';
const NOTIFICATION_INITIAL_BACKFILL_PENDING_PROPERTY = 'TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING';
const NOTIFICATION_LAST_SUCCESSFUL_SYNC_PROPERTY = 'TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT';
const USER_STORAGE_INITIALIZATION_REVISION_PROPERTY = 'TASKHUB_USER_STORAGE_INITIALIZATION_REVISION';
const USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY = 'TASKHUB_USER_STORAGE_INITIALIZATION_LAST_RUN_AT';
const USER_STORAGE_INITIALIZATION_REVISION = 'weekly-background-init-load-optimization-2026-10-05-v1';
const USER_STORAGE_INITIALIZATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const USER_STORAGE_MAINTENANCE_HANDLER = 'runWeeklyUserStorageMaintenance_';
const USER_TRIGGER_MAINTENANCE_HANDLER = 'run12HourlyUserTriggerMaintenance_';
const LEGACY_DAILY_TRIGGER_MAINTENANCE_HANDLER = 'runDailyUserTriggerMaintenance_';
const USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY = 'TASKHUB_USER_TRIGGER_MAINTENANCE_REVISION';
const USER_TRIGGER_MAINTENANCE_REVISION = '12-hour-sync-trigger-repair-2026-10-05-v1';

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

// Globals are isolated per Apps Script execution. Nested operations share its lock.
let userStorageLockDepth_ = 0;

const INCAMPUS_SHEET_NAME = 'inCampus通知';
const INCAMPUS_RECORD_TYPE_HEADER = 'レコード種別';
const INCAMPUS_GMAIL_RECORD_TYPE = 'gmail';
const INCAMPUS_EXTRACT_RECORD_TYPE = 'extract';
const INCAMPUS_UNIFIED_EXTRACT_HEADER_PREFIX = '抽出:';
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
const TEST_CASE_SESSION_STARTED_AT_PROPERTY = 'TASKHUB_TEST_CASE_SESSION_STARTED_AT';
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

const INCAMPUS_UNIFIED_HEADERS = HEADER_ROW.concat(
  INCAMPUS_RECORD_TYPE_HEADER,
  INCAMPUS_HEADERS.map(header => INCAMPUS_UNIFIED_EXTRACT_HEADER_PREFIX + header)
);
const INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN = HEADER_ROW.length;
const INCAMPUS_UNIFIED_EXTRACT_START_COLUMN = HEADER_ROW.length + 1;

// The shared test workbook contains fixed source values only. Virtual dates
// are applied to in-memory rows after Sheets has returned them.
const TEST_CASE_NOTIFICATION_HEADERS = HEADER_ROW;
const TEST_CASE_EXTRACT_HEADERS = INCAMPUS_HEADERS;
const TEST_CASE_SETTINGS_SHEET_NAME = 'テスト設定';

function doGet(e) {
  if (e && e.parameter && e.parameter.classroomApiTest === '1') {
    return HtmlService
      .createHtmlOutputFromFile('ClassroomApiExperiment')
      .setTitle('課題Hub Classroom API検証');
  }

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
  if (isUserStorageInitializationCurrent_()) {
    if (isUserTriggerMaintenanceConfigurationCurrent_()) return {ok: true, skipped: true};
    return runWithUserLock_('バックグラウンドトリガー設定', () => ensureUserTriggerMaintenanceConfigurationLocked_());
  }
  return runWithUserLock_('保存データ処理', () => ensureUserStorageForWebLocked_());
}

function isUserStorageInitializationCurrent_() {
  const props = PropertiesService.getUserProperties();
  const spreadsheetId = getConfiguredSpreadsheetId_() || props.getProperty(USER_SPREADSHEET_ID_PROPERTY);
  if (props.getProperty(USER_STORAGE_INITIALIZATION_REVISION_PROPERTY) !== USER_STORAGE_INITIALIZATION_REVISION ||
      !spreadsheetId) return false;
  const lastRun = Date.parse(props.getProperty(USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY) || '');
  return Number.isFinite(lastRun) && Date.now() - lastRun < USER_STORAGE_INITIALIZATION_INTERVAL_MS;
}

function isUserTriggerMaintenanceConfigurationCurrent_() {
  return PropertiesService.getUserProperties()
    .getProperty(USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY) === USER_TRIGGER_MAINTENANCE_REVISION;
}

function ensureUserTriggerMaintenanceConfigurationLocked_() {
  const startedAt = Date.now();
  const triggerMaintenance = ensure12HourlyUserTriggerMaintenanceTrigger_();
  const storageMaintenance = ensureWeeklyUserStorageMaintenanceTrigger_();
  PropertiesService.getUserProperties().setProperty(
    USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY,
    USER_TRIGGER_MAINTENANCE_REVISION
  );
  Logger.log('TASKHUB_TRIGGER_SETUP_TIMING ' + JSON.stringify({elapsedMs: Date.now() - startedAt}));
  return {
    ok: true,
    skipped: true,
    triggerMaintenanceCreated: triggerMaintenance.created,
    storageMaintenanceCreated: storageMaintenance.created,
    removedLegacyDailyTriggers: triggerMaintenance.removedLegacyDailyTriggers || 0
  };
}

function ensureUserStorageForWebLocked_() {
  try {
    const startedAt = Date.now();
    const ss = getOrCreateSpreadsheet_();

    ensureNotificationStorage_(ss);
    getOrCreateInCampusSheet_();
    const autoFetchTrigger = ensureAutoFetchTrigger_();
    const classroomApiTrigger = ensureClassroomApiTrigger_();
    const triggerMaintenance = ensure12HourlyUserTriggerMaintenanceTrigger_();
    const storageMaintenance = ensureWeeklyUserStorageMaintenanceTrigger_();
    const props = PropertiesService.getUserProperties();
    props.setProperty(USER_STORAGE_INITIALIZATION_REVISION_PROPERTY, USER_STORAGE_INITIALIZATION_REVISION);
    props.setProperty(USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY, new Date().toISOString());
    props.setProperty(USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY, USER_TRIGGER_MAINTENANCE_REVISION);
    Logger.log('TASKHUB_INITIALIZATION_TIMING ' + JSON.stringify({elapsedMs: Date.now() - startedAt}));

    return {
      ok: true,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      autoFetchTriggerCreated: autoFetchTrigger.created,
      classroomApiTriggerCreated: classroomApiTrigger.created,
      triggerMaintenanceCreated: triggerMaintenance.created,
      storageMaintenanceCreated: storageMaintenance.created,
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

function ensureWeeklyUserStorageMaintenanceTrigger_() {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === USER_STORAGE_MAINTENANCE_HANDLER);
  if (matchingTriggers.length) {
    matchingTriggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
    return {created: false, removedDuplicates: Math.max(0, matchingTriggers.length - 1)};
  }
  ScriptApp.newTrigger(USER_STORAGE_MAINTENANCE_HANDLER)
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(4)
    .create();
  return {created: true, removedDuplicates: 0};
}

function ensure12HourlyUserTriggerMaintenanceTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const legacyTriggers = triggers.filter(trigger =>
    trigger.getHandlerFunction() === LEGACY_DAILY_TRIGGER_MAINTENANCE_HANDLER
  );
  legacyTriggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  const matchingTriggers = triggers.filter(trigger =>
    trigger.getHandlerFunction() === USER_TRIGGER_MAINTENANCE_HANDLER
  );
  if (matchingTriggers.length) {
    matchingTriggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
    return {
      created: false,
      removedDuplicates: Math.max(0, matchingTriggers.length - 1),
      removedLegacyDailyTriggers: legacyTriggers.length
    };
  }
  ScriptApp.newTrigger(USER_TRIGGER_MAINTENANCE_HANDLER)
    .timeBased()
    .everyHours(12)
    .create();
  return {created: true, removedDuplicates: 0, removedLegacyDailyTriggers: legacyTriggers.length};
}

/** Repair sync triggers every 12 hours without opening or migrating the workbook. */
function run12HourlyUserTriggerMaintenance_() {
  return runWithUserLock_('12時間ごとの同期トリガー確認', () => {
    const startedAt = Date.now();
    const autoFetchTrigger = ensureAutoFetchTrigger_();
    const classroomApiTrigger = ensureClassroomApiTrigger_();
    const storageTrigger = ensureWeeklyUserStorageMaintenanceTrigger_();
    PropertiesService.getUserProperties().setProperty(
      USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY,
      USER_TRIGGER_MAINTENANCE_REVISION
    );
    const result = {
      ok: true,
      autoFetchTriggerCreated: autoFetchTrigger.created,
      classroomApiTriggerCreated: classroomApiTrigger.created,
      storageTriggerCreated: storageTrigger.created
    };
    Logger.log('TASKHUB_TRIGGER_MAINTENANCE_TIMING ' + JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      ...result
    }));
    return result;
  });
}

function runWeeklyUserStorageMaintenance_() {
  return runWithUserLock_('週次保存データ初期化', () => {
    const result = ensureUserStorageForWebLocked_();
    if (!result.ok) throw new Error(result.error || '週次の保存データ初期化に失敗しました。');
    return result;
  });
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
