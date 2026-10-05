#!/usr/bin/env node
// Local browser sandbox: runs the real GAS source against a persistent mock
// SpreadsheetApp/GmailApp. It binds only to loopback and never calls Google.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {URL} = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const GAS_DIR = path.join(ROOT, 'taskhub-split/taskhub-split');
const DATA_DIR = process.env.TASKHUB_LOCAL_DATA_DIR || path.join(__dirname, '.data');
const DATA_FILE = path.join(DATA_DIR, 'test-spreadsheet.json');
const TEST_WORKBOOK_PATH = process.env.TASKHUB_TEST_WORKBOOK || path.join(ROOT, 'test-fixtures/TaskHub-test-cases.xlsx');
const PORT = Number(process.env.TASKHUB_LOCAL_PORT || 4173);
const HOST = '127.0.0.1';
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const TEST_DUE_POSITIONS = new Set(['期限切れ', '今日まで', '明日まで', '今週中', '来週以降']);
const WEB_METHODS = new Set([
  'getNotificationsForWeb', 'getCompletedNotificationsForWeb',
  'refreshAndGetNotificationsForWeb', 'syncAndGetNotificationsForWeb', 'markNotificationDone',
  'markNotificationUndone', 'getUniversityNoticesForWeb',
  'setUniversityNoticeState', 'getSecuritySettingsForWeb', 'rotateApiTokenForWeb',
  'setTestCaseModeForWeb', 'getTestCaseClockStateForWeb', 'setTestCaseClockForWeb'
]);

function syntheticMail() {
  const today = new Date();
  const recent = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 9, 15);
  const classroomDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 10, 30);
  const ymd = d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const inCampusMulti = [
    '履修者：SIM-LOCAL-001', '曜日・時限：火曜5限', '授業名：仮想情報演習', '教員名：架空担当A', '更新内容：',
    '・課題（ローカル確認レポート1）が追加されました。(10/02 08:00)',
    '・課題（ローカル確認レポート1）が更新されました。(10/02 08:00)',
    '・課題（ローカル確認レポート2）が追加されました。(10/02 08:05)',
    '=====\n※これはローカル検証用の架空メールです。'
  ].join('\n');
  const multiCourse = [
    '履修者：SIM-LOCAL-002', '曜日・時限：月曜2限', '授業名：仮想心理演習', '教員名：架空担当B', '更新内容：',
    '・課題（仮想心理課題（４）予習）が追加されました。(10/02 11:27)', '',
    '履修者：SIM-LOCAL-003', '曜日・時限：火曜5限', '授業名：仮想情報演習', '教員名：架空担当A',
    '更新内容：', '・課題（ローカル提出済み確認）が提出されました。(10/02 12:29)',
    '=====\n※これはローカル検証用の架空メールです。'
  ].join('\n');
  const mail = (id, from, subject, body, date, permalink) => ({
    id, from, subject, body, date: date.toISOString(), permalink
  });
  return [
    mail('local-incampus-multi-001', 'taskhub-test-incampus@example.invalid', '更新通知', inCampusMulti, recent, 'https://mail.example.invalid/thread/local-incampus-multi-001'),
    mail('local-incampus-courses-002', 'taskhub-test-incampus@example.invalid', '更新通知', multiCourse, recent, 'https://mail.example.invalid/thread/local-incampus-courses-002'),
    mail('local-classroom-003', 'taskhub-test-classroom@example.invalid', '【仮想情報演習】新しい課題: 仮想確認クイズ', [
      '仮想情報演習', '架空担当A が新しい課題を投稿しました: 仮想確認クイズ',
      '期限: 10月15日 23:59', 'https://courses.example.invalid/demo/LOCAL-ASSIGNMENT'
    ].join('\n'), classroomDate, 'https://mail.example.invalid/thread/local-classroom-003')
  ];
}

function freshState() {
  return {spreadsheetId: 'local-test-spreadsheet', testSpreadsheetId: 'local-test-case-spreadsheet',
    sheets: {}, testSheets: {}, properties: {}, triggers: [],
    gmail: syntheticMail(), frozenRows: {}, testClock: null, testImportReport: null};
}

function excelSerialToLocalDate(value) {
  const utc = new Date(EXCEL_EPOCH_UTC + Math.round(Number(value) * 86400000));
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), utc.getUTCHours(),
    utc.getUTCMinutes(), utc.getUTCSeconds(), utc.getUTCMilliseconds());
}

function toWorkbookDate(value) {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 100000) {
    return excelSerialToLocalDate(value);
  }
  return null;
}

function atEndOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addCalendarDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function getTestTargetDeadline(startedAt, position) {
  const today = startOfDay(startedAt);
  if (position === '期限切れ') return atEndOfDay(addCalendarDays(today, -1));
  if (position === '今日まで') return atEndOfDay(today);
  if (position === '明日まで') return atEndOfDay(addCalendarDays(today, 1));
  const daysUntilSunday = (7 - today.getDay()) % 7;
  const endOfThisWeek = addCalendarDays(today, daysUntilSunday);
  if (position === '今週中') return atEndOfDay(endOfThisWeek);
  return atEndOfDay(addCalendarDays(endOfThisWeek, 7));
}

function getExpectedDeadlineGroup(testClock, deadline) {
  if (!deadline || deadline.getTime() < testClock.getTime()) return '期限切れ';
  const today = startOfDay(testClock);
  const dueDay = startOfDay(deadline);
  if (getCalendarDayNumber(dueDay) === getCalendarDayNumber(today)) return '今日まで';
  if (getCalendarDayNumber(dueDay) === getCalendarDayNumber(addCalendarDays(today, 1))) return '明日まで';
  const endOfWeek = addCalendarDays(today, (7 - today.getDay()) % 7);
  if (dueDay.getTime() <= endOfWeek.getTime()) return '今週中';
  return '来週以降';
}

function formatEmailDate(value, includeTime = false) {
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return includeTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

function expandTestMailTemplate(row, startedAt, testClock) {
  const [idValue, sourceValue, expectedGroupValue, subjectValue, templateValue] = row;
  const id = String(idValue || '').trim();
  const source = String(sourceValue || '').trim();
  const expectedGroup = String(expectedGroupValue || '').trim();
  if (!id || !source || !subjectValue || !templateValue) return null;
  const deadline = TEST_DUE_POSITIONS.has(expectedGroup)
    ? getTestTargetDeadline(testClock, expectedGroup)
    : null;
  const nextMidnight = addCalendarDays(startOfDay(testClock), 1);
  const tenMinutesBeforeReceipt = new Date(startedAt.getTime() - 10 * 60 * 1000);
  const fiveMinutesBeforeReceipt = new Date(startedAt.getTime() - 5 * 60 * 1000);
  const body = String(templateValue)
    .replaceAll('{{期限}}', deadline ? formatEmailDate(deadline) : '')
    .replaceAll('{{翌日0時}}', formatEmailDate(nextMidnight, true).replace(/\d{2}:\d{2}$/, '00:00'))
    .replaceAll('{{判定日}}', formatEmailDate(testClock))
    .replaceAll('{{受信日時10分前}}', formatEmailDate(tenMinutesBeforeReceipt, true))
    .replaceAll('{{受信日時5分前}}', formatEmailDate(fiveMinutesBeforeReceipt, true))
    .replaceAll('{{受信日}}', formatEmailDate(startedAt));
  if (/\{\{[^}]+\}\}/.test(body)) throw new Error(`テストメール ${id} の置換項目が未対応です。`);
  return {
    id, source,
    from: source === 'inCampus' ? 'taskhub-test-incampus@example.invalid' : 'taskhub-test-classroom@example.invalid',
    subject: String(subjectValue), body, date: startedAt.toISOString(),
    permalink: `https://mail.example.invalid/thread/${encodeURIComponent(id)}`,
    expectedGroup: deadline ? getExpectedDeadlineGroup(testClock, deadline) : expectedGroup,
    expectedDeadline: deadline ? new Date(deadline) : null
  };
}

function getCalendarDayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

function formatLocalDateTime(value) {
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function importTestWorkbookData() {
  if (!fs.existsSync(TEST_WORKBOOK_PATH)) throw new Error(`テストケースExcelが見つかりません: ${TEST_WORKBOOK_PATH}`);
  let workbookApi;
  try { workbookApi = require('@oai/artifact-tool'); }
  catch { throw new Error('Excel読込ライブラリが見つかりません。local-dev/start.sh から起動してください。'); }
  const {FileBlob, SpreadsheetFile} = workbookApi;
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(TEST_WORKBOOK_PATH));
  let settings;
  try { settings = workbook.worksheets.getItem('テスト設定'); }
  catch { throw new Error('テストケースExcelに「テスト設定」シートがありません。'); }
  const [positionValue, baseValue] = settings.getRange('B3:B4').values.map(row => row[0]);
  const position = String(positionValue || '来週以降');
  if (!TEST_DUE_POSITIONS.has(position)) throw new Error('「テスト設定」B3は期限切れ、今日まで、明日まで、今週中、来週以降のいずれかにしてください。');
  const baseDate = toWorkbookDate(baseValue);
  if (!baseDate) throw new Error('「テスト設定」B4に基準期限の日付を入力してください。');
  const configuredTestClock = toWorkbookDate(settings.getRange('B18').values[0][0]);

  const startedAt = new Date();
  const testClock = configuredTestClock || new Date(startedAt);
  const targetDeadline = getTestTargetDeadline(testClock, position);
  const shiftDays = getCalendarDayNumber(targetDeadline) - getCalendarDayNumber(baseDate);
  const readRows = (name) => {
    let sheet;
    try { sheet = workbook.worksheets.getItem(name); }
    catch { throw new Error(`テストケースExcelに「${name}」シートがありません。`); }
    const expectedWidth = name === 'inCampus抽出' ? 17 : name === 'テストメール' ? 8 : 16;
    return sheet.getUsedRange().values.map(row => row.slice(0, expectedWidth));
  };
  const readFixedTestRows = (name, extracted = false) => {
    let sheet;
    try { sheet = workbook.worksheets.getItem(name); }
    catch { throw new Error(`テストケースExcelに「${name}」シートがありません。`); }
    const width = extracted ? 17 : 16;
    const rows = sheet.getUsedRange().values.map(row => row.slice(0, width));
    const dateColumns = extracted ? [4, 5, 11, 12, 15] : [0, 5, 9, 13];
    rows.slice(1).forEach(row => {
      dateColumns.forEach(column => {
        const date = toWorkbookDate(row[column]);
        if (date) row[column] = date;
      });
    });
    return rows;
  };
  const updateNotificationRows = rows => {
    const anchors = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const originalDue = toWorkbookDate(row[5]);
      const isAnchor = originalDue && getCalendarDayNumber(originalDue) === getCalendarDayNumber(baseDate);
      row[0] = new Date(startedAt);
      row[5] = originalDue ? addCalendarDays(originalDue, shiftDays) : row[5];
      row[9] = new Date(startedAt);
      const completedAt = toWorkbookDate(row[13]);
      if (completedAt) row[13] = completedAt;
      if (isAnchor) anchors.push({due: row[5], dueStatus: row[6], isTask: gas.isTaskRelatedRow_(row)});
    }
    return anchors;
  };
  const classroomRows = readRows('Classroom通知');
  const inCampusRows = readRows('inCampus通知');
  const extractedRows = readRows('inCampus抽出');
  const testClassroomRows = readFixedTestRows('テストClassroom');
  const testInCampusRows = readFixedTestRows('テストinCampus');
  const testExtractedRows = readFixedTestRows('テスト抽出', true);
  const testSettingsRows = settings.getUsedRange().values.map(row => row.slice());
  if (testSettingsRows[3]) testSettingsRows[3][1] = baseDate;
  if (testSettingsRows[17]) testSettingsRows[17][1] = testClock;
  const notificationAnchors = updateNotificationRows(classroomRows).concat(updateNotificationRows(inCampusRows));
  const extractedAnchors = [];
  for (let i = 1; i < extractedRows.length; i++) {
    const row = extractedRows[i];
    const originalDue = toWorkbookDate(row[5]);
    const isAnchor = originalDue && getCalendarDayNumber(originalDue) === getCalendarDayNumber(baseDate);
    const startAt = toWorkbookDate(row[4]);
    if (startAt) row[4] = startAt;
    row[5] = originalDue ? addCalendarDays(originalDue, shiftDays) : row[5];
    row[12] = new Date(startedAt);
    const completedAt = toWorkbookDate(row[15]);
    if (completedAt) row[15] = completedAt;
    if (isAnchor) extractedAnchors.push({due: row[5], dueStatus: '拡張機能で抽出'});
  }

  const unifiedHeaders = vm.runInContext('INCAMPUS_UNIFIED_HEADERS', gas);
  const recordTypeColumn = vm.runInContext('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN', gas);
  const extractStartColumn = vm.runInContext('INCAMPUS_UNIFIED_EXTRACT_START_COLUMN', gas);
  const unifiedInCampusRows = [unifiedHeaders.slice()];
  inCampusRows.slice(1).forEach(sourceRow => {
    const row = Array(unifiedHeaders.length).fill('');
    sourceRow.forEach((value, index) => { row[index] = value; });
    row[recordTypeColumn] = 'gmail';
    unifiedInCampusRows.push(row);
  });
  extractedRows.slice(1).forEach(sourceRow => {
    const row = Array(unifiedHeaders.length).fill('');
    row[recordTypeColumn] = 'extract';
    sourceRow.forEach((value, index) => { row[extractStartColumn + index] = value; });
    unifiedInCampusRows.push(row);
  });

  const mailRows = readRows('テストメール').slice(1);
  const testMails = mailRows.map(row => expandTestMailTemplate(row, startedAt, testClock)).filter(Boolean);
  const uniqueMailIds = new Set(testMails.map(mail => mail.id));
  const duplicateInputCount = testMails.length - uniqueMailIds.size;
  const workbookRowCounts = {
    classroom: Math.max(0, classroomRows.length - 1),
    inCampus: Math.max(0, inCampusRows.length - 1),
    extracted: Math.max(0, extractedRows.length - 1)
  };
  const expectedDeadlineCases = [...new Map(testMails
    .filter(mail => TEST_DUE_POSITIONS.has(mail.expectedGroup))
    .map(mail => [mail.id, mail])).values()];

  state = freshState();
  state.spreadsheetId = 'local-test-workbook';
  state.testSpreadsheetId = 'local-test-case-workbook';
  state.testClock = testClock.toISOString();
  state.properties.TASKHUB_TEST_CASE_CLOCK = testClock.toISOString();
  state.properties.TASKHUB_TEST_CASE_SESSION_STARTED_AT = startedAt.toISOString();
  state.gmail = testMails;
  state.sheets = {
    '補足通知': classroomRows,
    'inCampus通知': unifiedInCampusRows
  };
  state.testSheets = {
    'テスト設定': testSettingsRows,
    'テストClassroom': testClassroomRows,
    'テストinCampus': testInCampusRows,
    'テスト抽出': testExtractedRows
  };
  const testFixtureBeforeRead = JSON.stringify(encode(state.testSheets));
  gas = createContext();
  const ingestion = gas.saveClassroomMailsToSheet();
  saveState();
  const notifications = gas.getNotificationsForWeb();
  const completed = gas.getCompletedNotificationsForWeb();
  const targetKey = `${targetDeadline.getFullYear()}-${String(targetDeadline.getMonth() + 1).padStart(2, '0')}-${String(targetDeadline.getDate()).padStart(2, '0')}`;
  const anchors = notificationAnchors.concat(extractedAnchors);
  const parsedAnchor = anchors.length ? gas.normalizeDueInfoForWeb_(anchors[0].due, anchors[0].dueStatus) : null;
  const anchorVisible = notifications.some(item => item.dueDateKey === targetKey && item.dueTime === '23:59');
  const fixtureChecks = expectedDeadlineCases.map(mail => {
    const match = notifications.find(item => item.messageId.startsWith(mail.id));
    const expectedDateKey = mail.expectedDeadline && `${mail.expectedDeadline.getFullYear()}-${String(mail.expectedDeadline.getMonth() + 1).padStart(2, '0')}-${String(mail.expectedDeadline.getDate()).padStart(2, '0')}`;
    const expectedExpired = mail.expectedGroup === '期限切れ';
    const expiredUnderVirtualClock = Boolean(match && gas.isExpiredNotificationForWeb_(match, testClock));
    const passed = Boolean(match && match.dueDateKey === expectedDateKey && expiredUnderVirtualClock === expectedExpired);
    return {
      id: mail.id, expectedGroup: mail.expectedGroup,
      expectedDue: mail.expectedDeadline ? formatLocalDateTime(mail.expectedDeadline) : '',
      actualDueDateKey: match?.dueDateKey || '', actualDueTime: match?.dueTime || '',
      expiredUnderVirtualClock, passed
    };
  });
  const multiMailItems = notifications.filter(item => item.messageId.startsWith('TEST-INCA-MULTI:'));
  const storedInCampusRows = state.sheets['inCampus通知'];
  const submissionAssignmentRow = storedInCampusRows.find(row => row[1] === 'TEST-INCA-SUBMIT-ASSIGN');
  const submissionEventRow = storedInCampusRows.find(row => row[1] === 'TEST-INCA-SUBMIT-EVENT');
  const submissionAssignment = submissionAssignmentRow
    ? gas.expandInCampusNotificationRow_(submissionAssignmentRow).find(row => row[4] === '同名照合課題' && row[3] === '仮想提出照合')
    : null;
  const submissionTargets = submissionEventRow
    ? Object.values(JSON.parse(String(submissionEventRow[15] || '{}'))).flat().map(String)
    : [];
  const unknownFixture = notifications.find(item => item.messageId === 'TEST-UNKNOWN');
  const invalidDateFixture = notifications.find(item => item.messageId === 'TEST-INVALID-DATE');
  const inCampusNoDueFixture = notifications.find(item => item.messageId.startsWith('TEST-INCA-NO-DUE:'));
  const returnedVisible = notifications.some(item => item.messageId === 'TEST-RETURNED');
  const noticeItems = gas.getUniversityNoticesForWeb();
  const receivedTimestampsSynced = [...classroomRows.slice(1), ...inCampusRows.slice(1)]
    .filter(row => String(row[1] || '').startsWith('TEST-'))
    .every(row => {
      const receivedAt = row[9] instanceof Date ? row[9].getTime() : new Date(row[9]).getTime();
      return Number.isFinite(receivedAt) && Math.abs(receivedAt - startedAt.getTime()) < 1000;
    });
  const categorySummary = Object.fromEntries(['期限切れ', '今日まで', '明日まで', '今週中', '来週以降']
    .map(group => [group, fixtureChecks.filter(item => item.expectedGroup === group && item.passed).length]));
  const coreDeadlineIds = new Set(['TEST-EXPIRED', 'TEST-TODAY', 'TEST-TOMORROW', 'TEST-THIS-WEEK', 'TEST-NEXT-WEEK']);
  const coreDeadlineChecks = fixtureChecks.filter(item => coreDeadlineIds.has(item.id));
  const checks = {
    allFiveDeadlineBoundariesParsed: coreDeadlineChecks.length === 5 && coreDeadlineChecks.every(item => item.passed),
    dateOnlyAndMidnightCasesPassed: fixtureChecks.filter(item => item.id === 'TEST-DATE-ONLY' || item.id === 'TEST-MIDNIGHT').length === 2 && fixtureChecks.filter(item => item.id === 'TEST-DATE-ONLY' || item.id === 'TEST-MIDNIGHT').every(item => item.passed),
    categoryCasesAllPresent: ['今日まで', '明日まで', '今週中', '来週以降'].every(group => categorySummary[group] > 0),
    expiredCaseCorrectAgainstVirtualClock: fixtureChecks.find(item => item.expectedGroup === '期限切れ')?.expiredUnderVirtualClock === true,
    unknownDateNotInferredFromMetadataOrUrl: Boolean(unknownFixture && unknownFixture.dueType !== 'detected' && !unknownFixture.dueDateKey),
    invalidDateNotAccepted: Boolean(invalidDateFixture && invalidDateFixture.dueType !== 'detected' && !invalidDateFixture.dueDateKey),
    inCampusUpdateTimeNotUsedAsDeadline: Boolean(inCampusNoDueFixture && inCampusNoDueFixture.dueType !== 'detected' && !inCampusNoDueFixture.dueDateKey),
    returnedClassroomMailExcluded: !returnedVisible,
    inCampusSameEmailSplitsDistinctTasks: multiMailItems.length === 2,
    duplicateGmailIdSavedOnce: duplicateInputCount === 1 && classroomRows.filter(row => row[1] === 'TEST-TODAY').length === 1,
    receivedTimestampsSyncedToActualStart: receivedTimestampsSynced,
    testFixtureDatesRemainFixed: JSON.stringify(encode(state.testSheets)) === testFixtureBeforeRead,
    inCampusSubmissionAppliedToMatchingTask: Boolean(submissionAssignment && submissionAssignment[12] === '完了' && submissionTargets.length === 1 && submissionTargets[0] === submissionAssignment[1]),
    announcementKeptOutOfTaskList: !notifications.some(item => item.messageId === 'TEST-ANNOUNCEMENT') && noticeItems.some(item => item.messageId === 'TEST-ANNOUNCEMENT')
  };
  if (Object.values(checks).some(value => !value)) throw new Error(`異常系メールの実コード検証が失敗しました: ${JSON.stringify({checks, fixtureChecks, categorySummary, unknownFixture, invalidDateFixture, inCampusNoDueFixture, receivedTimestampExamples: [...classroomRows.slice(1), ...inCampusRows.slice(1)].filter(row => String(row[1] || '').startsWith('TEST-')).slice(0, 3).map(row => ({id: row[1], receivedAt: String(row[9]), receivedAtType: Object.prototype.toString.call(row[9])})), multiMailItems: multiMailItems.map(item => item.title), submissionRows: [submissionAssignment && {id: submissionAssignment[1], status: submissionAssignment[12]}, submissionEventRow && {id: submissionEventRow[1], ledger: submissionEventRow[15]}]})}`);
  state.testImportReport = {testStartAt: formatLocalDateTime(startedAt), virtualDisplayAt: formatLocalDateTime(testClock), checks, fixtureChecks, categorySummary};
  saveState();
  return {
    workbook: path.basename(TEST_WORKBOOK_PATH),
    testStartAt: formatLocalDateTime(startedAt),
    virtualDisplayAt: formatLocalDateTime(testClock),
    targetPosition: position,
    targetDeadline: formatLocalDateTime(targetDeadline),
    shiftedByDays: shiftDays,
    classroomRows: workbookRowCounts.classroom,
    inCampusRows: workbookRowCounts.inCampus,
    extractedRows: workbookRowCounts.extracted,
    importedClassroomRows: Math.max(0, classroomRows.length - 1),
    importedInCampusRows: Math.max(0, inCampusRows.length - 1),
    adversarialEmailRows: testMails.length,
    uniqueAdversarialEmails: uniqueMailIds.size,
    duplicateEmailInputsIgnored: duplicateInputCount,
    ingestedAdversarialEmails: ingestion.savedCount,
    anchorRows: anchors.length,
    anchorTaskRows: notificationAnchors.filter(anchor => anchor.isTask).length,
    anchorParsedWithRealCode: Boolean(parsedAnchor && parsedAnchor.dueDateKey === targetKey),
    anchorVisibleInRealCode: anchorVisible,
    displayedTaskCount: notifications.length,
    categorySummary,
    fixtureChecks,
    checks
  };
}

function encode(value) {
  if (value instanceof Date) return {$localDate: value.toISOString()};
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if (typeof value.$localDate === 'string') return new Date(value.$localDate);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}
function saveState() {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  fs.writeFileSync(DATA_FILE, JSON.stringify(encode(state), null, 2));
}
function loadState() {
  try { state = decode(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch { state = freshState(); saveState(); }
}
let state;
loadState();
state.testClock ??= null;
state.testImportReport ??= null;
state.testSpreadsheetId ??= 'local-test-case-spreadsheet';
state.testSheets ??= {};

class LocalSheet {
  constructor(name, collection = () => state.sheets, readOnly = false) {
    this.name = name;
    this.collection = collection;
    this.readOnly = readOnly;
    this.collection()[name] ||= [];
  }
  rows() { this.collection()[this.name] ||= []; return this.collection()[this.name]; }
  getName() { return this.name; }
  getSheetId() { return Object.keys(this.collection()).indexOf(this.name) + 1; }
  getLastRow() {
    const rows = this.rows(); let last = rows.length;
    while (last && rows[last - 1].every(v => v === '' || v == null)) last--;
    return last;
  }
  getLastColumn() { return Math.max(0, ...this.rows().map(row => row.length)); }
  getMaxRows() { return Math.max(100, this.rows().length); }
  getFrozenRows() { return state.frozenRows[this.name] || 0; }
  setFrozenRows(count) { state.frozenRows[this.name] = count; }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(row, col, height = 1, width = 1) {
    const sheet = this;
    const range = {
      getValues() {
        const rows = sheet.rows();
        return Array.from({length: height}, (_, r) => Array.from({length: width}, (_, c) => rows[row + r - 1]?.[col + c - 1] ?? ''));
      },
      setValues(values) {
        if (sheet.readOnly) throw new Error('テストケース用シートは読み取り専用です。');
        if (values.length !== height || values.some(item => item.length !== width)) throw new Error('テストシートのsetValues範囲が一致しません。');
        const rows = sheet.rows();
        for (let r = 0; r < height; r++) {
          rows[row + r - 1] ||= [];
          for (let c = 0; c < width; c++) rows[row + r - 1][col + c - 1] = values[r][c];
        }
        saveState(); return range;
      },
      setValue(value) { return range.setValues([[value]]); },
      clearContent() { return range.setValues(Array.from({length: height}, () => Array(width).fill(''))); },
      setFontWeight() { return range; }
    };
    return range;
  }
  appendRow(row) { if (this.readOnly) throw new Error('テストケース用シートは読み取り専用です。'); this.rows().push(row); saveState(); return this; }
  deleteRows(start, count) { if (this.readOnly) throw new Error('テストケース用シートは読み取り専用です。'); this.rows().splice(start - 1, count); saveState(); }
  insertRowsAfter() { if (this.readOnly) throw new Error('テストケース用シートは読み取り専用です。'); /* row capacity is elastic in this local sheet */ }
}

function createLocalSpreadsheet(getId, getCollection, readOnly = false) {
  return {
    getId,
    getUrl: () => 'http://127.0.0.1:' + PORT + '/__local/sheet',
    getSheetByName: name => Object.hasOwn(getCollection(), name) ? new LocalSheet(name, getCollection, readOnly) : null,
    insertSheet(name) {
      if (readOnly) throw new Error('テストケース用スプレッドシートは読み取り専用です。');
      getCollection()[name] = []; saveState(); return new LocalSheet(name, getCollection, readOnly);
    },
    deleteSheet(sheet) {
      if (readOnly) throw new Error('テストケース用スプレッドシートは読み取り専用です。');
      delete getCollection()[sheet.getName()]; saveState();
    }
  };
}
const spreadsheet = createLocalSpreadsheet(() => state.spreadsheetId, () => state.sheets);
const testSpreadsheet = createLocalSpreadsheet(() => state.testSpreadsheetId, () => state.testSheets, true);

function gasFormatDate(value, _zone, pattern) {
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  const isoDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const full = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (pattern === 'yyyy-MM-dd') return isoDate;
  if (pattern === 'yyyy/MM/dd HH:mm:ss') return full;
  if (pattern === 'yyyy/MM/dd HH:mm') return full.slice(0, 16);
  if (pattern === 'yyyy/MM/dd') return full.slice(0, 10);
  return full;
}

function buildHtml() {
  const source = fs.readFileSync(path.join(GAS_DIR, 'Index.html'), 'utf8');
  const rendered = source.replace(/<\?!=\s*include\(['"]([^'"]+)['"]\)\s*;?\s*\?>/g, (_all, name) => fs.readFileSync(path.join(GAS_DIR, name + '.html'), 'utf8'));
  const testClock = state.testClock ? new Date(state.testClock) : null;
  const titlePage = rendered.replace(/<head>/i, '<head><script>\n' + LOCAL_BRIDGE + '\n</script>');
  const banner = `<div id="local-test-clock" style="background:#fff4d6;color:#633d00;border-bottom:1px solid #e5c66b;padding:9px 14px;text-align:center;font:13px system-ui,sans-serif">ローカル検証環境：テスト日時は設定または課題ヘッダーから選択できます。メール受信日時は取込時刻で記録します。</div>`;
  return titlePage.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
}

const LOCAL_BRIDGE = `
window.google = {script: {
  url: {getLocation(callback) { const params = new URLSearchParams(location.search); callback({parameter: Object.fromEntries(params.entries())}); } },
  run: (() => { const makeRunner = (handlers={}) => new Proxy({}, { get(_target, property) {
    if (property === 'withSuccessHandler') return fn => makeRunner({...handlers, success:fn});
    if (property === 'withFailureHandler') return fn => makeRunner({...handlers, failure:fn});
    return (...args) => fetch('/__local/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method:String(property), args})})
      .then(async response => { const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || response.statusText); return result.value; })
      .then(value => { if(handlers.success) handlers.success(value); })
      .catch(error => { if(handlers.failure) handlers.failure(error); else console.error(error); });
  }}); return makeRunner(); })()
}};
`;

function createContext() {
  const NativeDate = Date;
  const props = {
    getProperty(key) { return state.properties[key] ?? null; },
    setProperty(key, value) { state.properties[key] = String(value); saveState(); return this; },
    deleteProperty(key) { delete state.properties[key]; saveState(); },
    getProperties() { return {...state.properties}; }
  };
  const triggerApi = {
    handler: '',
    getHandlerFunction() { return this.handler; }
  };
  const triggerBuilder = handler => {
    const record = {handler, cadence: '', interval: 0};
    const trigger = {
      getHandlerFunction: () => record.handler,
      timeBased() { return this; },
      everyMinutes(minutes) { record.cadence = 'minutes'; record.interval = minutes; return this; },
      everyHours(hours) { record.cadence = 'hours'; record.interval = hours; return this; },
      create() { state.triggers.push(record); saveState(); return trigger; }
    };
    return trigger;
  };
  const gmailApp = {
    search(_query, offset, limit) {
      const records = state.gmail.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
      return records.slice(offset, offset + limit).map(item => {
        const message = {
          getId: () => item.id, getFrom: () => item.from,
          getDate: () => new Date(item.date), getSubject: () => item.subject,
          getPlainBody: () => item.body
        };
        return {getMessages: () => [message], getPermalink: () => item.permalink};
      });
    }
  };
  const context = vm.createContext({
    Date: NativeDate, Set, Map, URL, console,
    Logger: {log() {}},
    SpreadsheetApp: {
      openById(id) {
        if (id === state.spreadsheetId) return spreadsheet;
        if (id === state.testSpreadsheetId) return testSpreadsheet;
        throw new Error('ローカルテスト以外のシートIDには接続しません。');
      },
      create() { return spreadsheet; }, flush() { saveState(); }
    },
    PropertiesService: {
      getUserProperties: () => props,
      getScriptProperties: () => ({getProperty(key) { return key === 'TASKHUB_TEST_SPREADSHEET_ID' ? state.testSpreadsheetId : null; }})
    },
    LockService: {getUserLock: () => ({tryLock: () => true, releaseLock() {}})},
    Session: {getScriptTimeZone: () => 'Asia/Tokyo'},
    Utilities: {
      DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest(_algo, value) { return [...crypto.createHash('sha256').update(String(value)).digest()].map(n => n > 127 ? n - 256 : n); },
      getUuid: () => crypto.randomUUID(), formatDate: gasFormatDate
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers.map(record => ({
        getHandlerFunction: () => typeof record === 'string' ? record : record.handler
      })),
      newTrigger: handler => triggerBuilder(handler),
      deleteTrigger(trigger) {
        const handler = trigger.getHandlerFunction();
        const index = state.triggers.findIndex(record => (typeof record === 'string' ? record : record.handler) === handler);
        if (index >= 0) state.triggers.splice(index, 1);
        saveState();
      }
    },
    GmailApp: gmailApp,
    Classroom: {Courses: {list: () => ({courses: []})}},
    ContentService: {MimeType: {JSON: 'application/json'}, createTextOutput(value) { return {value, setMimeType() {return this;}}; }},
    HtmlService: {
      createTemplateFromFile() { return {evaluate() { return {getContent: buildHtml, setTitle() {return this;}}; }}; },
      createHtmlOutputFromFile(name) { return {getContent: () => fs.readFileSync(path.join(GAS_DIR, name + '.html'), 'utf8')}; }
    }
  });
  const gasFiles = fs.readdirSync(GAS_DIR).filter(name => name.endsWith('.gs'))
    .sort((a, b) => a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a.localeCompare(b));
  const code = gasFiles.map(name => fs.readFileSync(path.join(GAS_DIR, name), 'utf8')).join('\n');
  vm.runInContext(code, context, {filename: 'taskhub-gas-local.vm.js'});
  return context;
}
let gas = createContext();

function send(res, status, value, type = 'application/json; charset=utf-8') {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; if (raw.length > 250000) reject(new Error('リクエストが大きすぎます。')); });
    req.on('end', () => { try {resolve(raw ? JSON.parse(raw) : {});} catch {reject(new Error('JSON形式が正しくありません。'));} });
    req.on('error', reject);
  });
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function dashboard() {
  const renderSheets = (label, collection) => {
    const content = Object.entries(collection).map(([name, rows]) => `<section><h2>${esc(name)} <small>${rows.length} rows</small></h2><div class="table-scroll"><table><tbody>${rows.map(row => '<tr>' + row.map(cell => `<td>${esc(cell instanceof Date ? cell.toLocaleString('ja-JP') : cell)}</td>`).join('') + '</tr>').join('')}</tbody></table></div></section>`).join('');
    return `<section><h2>${esc(label)}</h2>${content || '<p>まだシートがありません。テストケースExcelを読み込んでください。</p>'}</section>`;
  };
  const sheets = renderSheets('個人用保存先（ローカル検証用）', state.sheets) + renderSheets('テストケースExcel（読み取り専用）', state.testSheets);
  const report = state.testImportReport;
  const reportView = report ? `<section><h2>最新の仕様テスト結果</h2><p>メール受信時刻：${esc(report.testStartAt || 'テスト開始時刻')}。期限判定用の仮想日時：${esc(report.virtualDisplayAt || formatLocalDateTime(state.testClock))}。</p><table><tbody><tr><td>確認項目</td><td>結果</td></tr>${Object.entries(report.checks).map(([name, passed]) => `<tr><td>${esc(name)}</td><td>${passed ? 'PASS' : 'FAIL'}</td></tr>`).join('')}</tbody></table><h3>期限ケース</h3><table><tbody><tr><td>テストID</td><td>期待区分</td><td>期限</td><td>指定日時で期限切れ</td><td>結果</td></tr>${report.fixtureChecks.map(item => `<tr><td>${esc(item.id)}</td><td>${esc(item.expectedGroup)}</td><td>${esc(item.expectedDue)}</td><td>${item.expiredUnderVirtualClock ? 'はい' : 'いいえ'}</td><td>${item.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('')}</tbody></table></section>` : '';
  const dataPathLabel = DATA_DIR === path.join(__dirname, '.data') ? 'local-dev/.data/test-spreadsheet.json' : DATA_FILE;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>課題Hub ローカル検証</title><style>
    :root{font:15px system-ui,sans-serif;color:#17231f;background:#f4f7f5}body{max-width:1180px;margin:32px auto;padding:0 20px}header,.card{background:#fff;border:1px solid #dce7e0;border-radius:12px;padding:20px;margin-bottom:16px}h1{margin:0 0 8px}p{line-height:1.55}.badge{display:inline-block;border-radius:99px;background:#e0f2e9;color:#14532d;padding:5px 10px;font-weight:700}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}a,button{font:inherit;border:0;border-radius:8px;padding:10px 14px;background:#17804f;color:white;text-decoration:none;cursor:pointer}button.secondary{background:#e7eee9;color:#17231f}button.danger{background:#a43a34;color:#fff}section{background:white;margin:14px 0;padding:16px;border:1px solid #dce7e0;border-radius:12px}.table-scroll{overflow:auto;max-height:420px}table{border-collapse:collapse;font-size:12px}td{max-width:340px;min-width:80px;vertical-align:top;border:1px solid #e2e8e4;padding:6px;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#64756b;font-weight:400}#message{min-height:22px;color:#14532d}
    </style><body><header><span class="badge">ローカルのみ・Google通信なし</span><h1>課題Hub 開発環境</h1><p>実際のGASコードをローカルで動かします。テスト開始時に受信日時を同期し、期限判定用の仮想日時で全区分を確認します。</p><div class="actions"><a href="/">アプリ画面を開く</a><button id="importWorkbook">テストケースExcelから開始</button><button id="import">サンプルメールを取り込む</button><button id="reset" class="danger">テストデータを初期状態に戻す</button><a class="secondary" href="/__local/data" download>テストシートJSONを保存</a></div><p>元データの目標位置を変更した場合は、Excelを保存してから開始してください。</p><div id="message"></div></header><div class="card"><h2>保存済みテストシート</h2><p>この表は <code>${esc(dataPathLabel)}</code> に保存されます。実際のGoogle DriveやGmailには接続しません。</p></div>${reportView}${sheets}<script>
    async function run(path){const m=document.getElementById('message');m.textContent='処理中…';try{const r=await fetch(path,{method:'POST'});const j=await r.json();if(!r.ok)throw new Error(j.error);m.textContent=JSON.stringify(j.result||j);setTimeout(()=>location.reload(),600)}catch(e){m.textContent='失敗: '+e.message}}
    document.getElementById('importWorkbook').onclick=()=>run('/__local/import-workbook');document.getElementById('import').onclick=()=>run('/__local/import');document.getElementById('reset').onclick=()=>{if(confirm('ローカルのテストデータを初期化しますか？'))run('/__local/reset')};
    </script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
    if (req.method === 'GET' && url.pathname === '/') {
      const page = gas.doGet().getContent(); return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/__local') return send(res, 200, dashboard(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/__local/data') return send(res, 200, JSON.stringify(encode(state), null, 2), 'application/json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/__local/copy') {
      const sourceFiles = ({
        c: ['Code.gs', ...fs.readdirSync(GAS_DIR).filter(name => name.endsWith('.gs') && name !== 'Code.gs')],
        s: ['Scripts.html', 'ScriptsHome.html', 'ScriptsSettings.html', 'ScriptsSync.html', 'ScriptsCourseFilter.html', 'ScriptsRendering.html', 'ScriptsActions.html', 'ScriptsBoot.html'],
        u: ['UniversityScripts.html']
      })[url.searchParams.get('id')];
      if (!sourceFiles) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      const escaped = sourceFiles.map(filename => fs.readFileSync(path.join(GAS_DIR, filename), 'utf8')).join('\n')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const page = `<!doctype html><meta charset="utf-8"><title>ローカルソースのコピー</title><textarea autofocus readonly style="width:98vw;height:96vh;white-space:pre;font:12px monospace">${escaped}</textarea>`;
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, {ok: true, mode: 'local-mock', dataFile: path.relative(ROOT, DATA_FILE)});
    if (req.method === 'POST' && url.pathname === '/__local/rpc') {
      const input = await readBody(req);
      if (!WEB_METHODS.has(input.method)) return send(res, 403, {error: 'このローカル画面からは呼び出せない関数です。'});
      const result = gas[input.method](...(Array.isArray(input.args) ? input.args : []));
      if (input.method === 'setTestCaseClockForWeb') state.testClock = state.properties.TASKHUB_TEST_CASE_CLOCK || null;
      saveState(); return send(res, 200, {value: result});
    }
    if (req.method === 'POST' && url.pathname === '/__local/import') {
      const result = gas.saveClassroomMailsToSheet(); saveState(); return send(res, 200, {ok: true, result});
    }
    if (req.method === 'POST' && url.pathname === '/__local/import-workbook') {
      const result = await importTestWorkbookData();
      return send(res, 200, {ok: true, result});
    }
    if (req.method === 'POST' && url.pathname === '/__local/reset') {
      state = freshState(); gas = createContext(); saveState();
      const result = gas.saveClassroomMailsToSheet(); saveState(); return send(res, 200, {ok: true, result});
    }
    return send(res, 404, {error: 'Not found'});
  } catch (error) {
    saveState(); return send(res, 500, {error: String(error?.message || error)});
  }
});

if (process.argv.includes('--smoke') || process.argv.includes('--smoke-workbook')) {
  const workbookSmoke = process.argv.includes('--smoke-workbook');
  server.listen(0, HOST, async () => {
    const address = server.address();
    try {
      const origin = `http://${HOST}:${address.port}`;
      const page = await fetch(origin + '/');
      const html = await page.text();
      if (!page.ok || !html.includes('id="home-view"') || !html.includes('font-family: system-ui') || html.includes('<?!=')) throw new Error('local app template did not render its includes/styles');
      const health = await fetch(origin + '/health').then(r => r.json());
      if (!health.ok || health.mode !== 'local-mock') throw new Error('local health failed');
      const emptyList = await fetch(origin + '/__local/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method:'getNotificationsForWeb', args:[]})}).then(r => r.json());
      if (emptyList.error || !Array.isArray(emptyList.value) || emptyList.value.length) throw new Error('first-run workbook did not begin with an empty list');
      const newWorkbookId = state.properties.TASKHUB_SPREADSHEET_ID;
      if (!newWorkbookId || state.properties.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING !== 'true' ||
          state.sheets['補足通知']?.length !== 1 || state.sheets['inCampus通知']?.length !== 1 ||
          state.sheets['授業']?.length !== 1 || state.sheets['Classroom課題']?.length !== 1 ||
          state.sheets['提出状況']?.length !== 1) throw new Error('first page read did not create a new workbook with initialized headers');
      const result = await fetch(origin + '/__local/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method:'syncAndGetNotificationsForWeb', args:[]})}).then(r => r.json());
      if (result.error || !result.value?.apiSuccess || result.value?.classroomSavedCount < 1 || result.value?.inCampusSavedCount < 2 || result.value?.items?.length < 3) throw new Error(`first-run API + Gmail sync did not save and return tasks: ${JSON.stringify(result)}`);
      if (state.properties.TASKHUB_SPREADSHEET_ID !== newWorkbookId || state.properties.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING) throw new Error('first-run sync did not reuse the new workbook or clear its pending flag');
      if (state.sheets['補足通知']?.length !== 2 || state.sheets['inCampus通知']?.length !== 3) throw new Error('first-run Gmail rows were not persisted in the new workbook');
      process.stdout.write('PASS first-run creates a personal workbook, saves initial mail rows, and returns tasks for display\n');
      const notifications = await fetch(origin + '/__local/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method:'getNotificationsForWeb', args:[]})}).then(r => r.json());
      if (notifications.error || !Array.isArray(notifications.value) || notifications.value.length < 3) throw new Error('local GAS RPC failed');
      const target = notifications.value.find(item => item.title === 'ローカル確認レポート1');
      if (!target) throw new Error('multi-update mail was not split into logical tasks');
      await fetch(origin + '/__local/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method:'markNotificationDone', args:[target.messageId]})}).then(async r => {const v = await r.json(); if (!r.ok || v.error) throw new Error(v.error || 'mark done failed');});
      const completed = await fetch(origin + '/__local/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method:'getCompletedNotificationsForWeb', args:[]})}).then(r => r.json());
      if (!completed.value?.some(item => item.messageId === target.messageId)) throw new Error('local done/undo RPC did not persist its status');
      const deadline = gas.normalizeDueInfoForWeb_(new Date(2026, 9, 15, 0, 0), 'Classroomで時刻補正');
      if (deadline.dueDateKey !== '2026-10-14' || deadline.dueTime !== '23:59') throw new Error('midnight deadline regression in local sandbox');
      if (workbookSmoke) {
        const imported = await fetch(origin + '/__local/import-workbook', {method: 'POST'}).then(r => r.json());
        if (!imported.ok || !imported.result || imported.result.anchorRows < 1 || !imported.result.anchorParsedWithRealCode || imported.result.displayedTaskCount < 1) throw new Error(`spreadsheet test case did not reach the real GAS code: ${JSON.stringify(imported)}`);
        if (imported.result.classroomRows !== 29 || imported.result.inCampusRows !== 127 || imported.result.extractedRows !== 19) throw new Error('spreadsheet test case row counts changed unexpectedly');
        if (imported.result.adversarialEmailRows < 15 || imported.result.ingestedAdversarialEmails !== imported.result.uniqueAdversarialEmails || imported.result.duplicateEmailInputsIgnored !== 1) throw new Error(`adversarial email fixtures were not all ingested/idempotent: ${JSON.stringify(imported.result)}`);
        if (Object.values(imported.result.checks || {}).some(value => value !== true)) throw new Error(`repository regression checks failed: ${JSON.stringify(imported.result.checks)}`);
        const requiredDeadlineGroups = ['今日まで', '明日まで', '来週以降'];
        if (![0, 6].includes(new Date(state.testClock).getDay())) requiredDeadlineGroups.push('今週中');
        if (!requiredDeadlineGroups.every(group => imported.result.categorySummary?.[group] > 0)) throw new Error(`expected deadline groups are missing for selected weekday: ${JSON.stringify({requiredDeadlineGroups, summary: imported.result.categorySummary})}`);
        const current = Date.now();
        const dateIsRecent = value => value instanceof Date && Math.abs(value.getTime() - current) < 10000;
        const recordTypeColumn = vm.runInContext('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN', gas);
        const extractStartColumn = vm.runInContext('INCAMPUS_UNIFIED_EXTRACT_START_COLUMN', gas);
        const unifiedRows = state.sheets['inCampus通知'].slice(1);
        const storedInCampusMailRows = unifiedRows.filter(row => row[recordTypeColumn] === 'gmail');
        const storedInCampusExtractRows = unifiedRows.filter(row => row[recordTypeColumn] === 'extract');
        if (!state.sheets['補足通知'].slice(1).every(row => dateIsRecent(row[0]) && dateIsRecent(row[9])) ||
            !storedInCampusMailRows.every(row => dateIsRecent(row[0]) && dateIsRecent(row[9])) ||
            !storedInCampusExtractRows.every(row => dateIsRecent(row[extractStartColumn + 12]))) throw new Error('spreadsheet test mail timestamps were not synchronized to test start');
        const originalSheetId = state.spreadsheetId;
        const readiness = gas.getSecuritySettingsForWeb();
        if (!readiness.testSpreadsheetReady) throw new Error(`fixed local test spreadsheet was not ready: ${readiness.testSpreadsheetMessage}`);
        state.testSheets['テスト設定'][2][1] = '明日まで';
        const fixtureBeforeMode = JSON.stringify(encode(state.testSheets));
        gas.setTestCaseModeForWeb(true);
        if (gas.getOrCreateSpreadsheet_().getId() !== originalSheetId) throw new Error('test mode changed the personal workbook destination');
        const testNotificationSources = gas.getNotificationReadSheets_();
        if (testNotificationSources['Google Classroom']?.rows() !== state.testSheets['テストClassroom'] ||
            testNotificationSources.inCampus?.rows() !== state.testSheets['テストinCampus']) throw new Error('test mode did not select the prepared notification tabs');
        if (gas.getInCampusReadSheet_().rows() !== state.testSheets['テスト抽出']) throw new Error('test mode did not select the prepared extraction tab');
        const visibleFixtureItems = gas.getNotificationsForWeb();
        const fixtureItem = visibleFixtureItems.find(item => item.source === 'inCampus');
        if (!fixtureItem) throw new Error(`test mode did not read virtual notifications from the fixture workbook (${visibleFixtureItems.length} cards visible)`);
        if (fixtureItem.dueDate !== '2026/12/31 23:59' || fixtureItem.dueTime !== '23:59') throw new Error(`test mode did not shift the fixed inCampus deadline after reading: ${JSON.stringify({dueDate:fixtureItem.dueDate,dueTime:fixtureItem.dueTime})}`);
        const personalWorkbookSync = gas.saveClassroomMailsToSheet();
        if (personalWorkbookSync.skipped || personalWorkbookSync.spreadsheetId !== originalSheetId) throw new Error('test mode did not keep Gmail sync directed to the personal workbook');
        if (JSON.stringify(encode(state.testSheets)) !== fixtureBeforeMode) throw new Error('Gmail sync changed the read-only test fixture workbook');
        gas.updateNotificationStatus_(fixtureItem.messageId, '完了', () => []);
        if (JSON.stringify(encode(state.testSheets)) !== fixtureBeforeMode) throw new Error('test completion wrote into the read-only fixture workbook');
        const apiToken = gas.rotateApiTokenForWeb().apiToken;
        const beforeExtensionPost = storedInCampusExtractRows.length;
        const postResponse = gas.doPost({postData:{contents:JSON.stringify({apiToken,action:'upsertInCampusAssignment',assignment:{
          source:'inCampus',type:'assignment',title:'仮想保存先確認',courseName:'仮想保存先',pageUrl:'https://ic.ss.senshu-u.ac.jp/lms/course/report/local-test-destination'
        }})}});
        if (!JSON.parse(postResponse.value).ok) throw new Error('extension POST failed while test mode was ON');
        const extractedAfterPost = state.sheets['inCampus通知'].slice(1).filter(row => row[recordTypeColumn] === 'extract');
        if (extractedAfterPost.length !== beforeExtensionPost + 1 ||
            !extractedAfterPost.some(row => row[extractStartColumn + 2] === '仮想保存先確認')) throw new Error('extension POST did not save into the original personal workbook');
        if (JSON.stringify(encode(state.testSheets)) !== fixtureBeforeMode) throw new Error('extension POST changed the read-only fixture workbook');
        gas.setTestCaseModeForWeb(false);
        const liveExtractAdapter = gas.getInCampusReadSheet_();
        if (!liveExtractAdapter.__inCampusExtractAdapter || liveExtractAdapter.getLastRow() !== extractedAfterPost.length + 1) throw new Error('OFF did not restore reads from the personal workbook');
        if (JSON.stringify(encode(state.testSheets)) !== fixtureBeforeMode) throw new Error('test fixture workbook changed during the personal-save check');
        process.stdout.write(`PASS workbook import: ${imported.result.classroomRows} saved Classroom, ${imported.result.inCampusRows} saved inCampus, ${imported.result.extractedRows} extracted rows; ${imported.result.uniqueAdversarialEmails} adversarial emails passed actual GAS ingestion; categories ${JSON.stringify(imported.result.categorySummary)}; received timestamps synchronized; virtual UI date ${imported.result.virtualDisplayAt}\n`);
        process.stdout.write('PASS test mode reads the separate fixture, keeps completion state per-user, syncs synthetic Gmail only to the personal workbook, and writes extension POSTs there\n');
      }
      process.stdout.write('PASS local browser app, actual GAS functions, synthetic Gmail, persistent test sheet, multi-record state, done/completed RPC, and midnight deadline\n');
      server.close(() => process.exit(0));
    } catch (error) { console.error(error); server.close(() => process.exit(1)); }
  });
} else {
  server.listen(PORT, HOST, () => {
    console.log(`課題Hub ローカル環境: http://${HOST}:${PORT}/`);
    console.log(`テストシート:       http://${HOST}:${PORT}/__local`);
    console.log('ローカル実行です。Google Drive/Gmail/Apps Scriptへ通信しません。停止は Ctrl+C。');
  });
}
