const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class MockRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    Object.assign(this, {sheet, row, column, rowCount, columnCount});
  }

  getValues() {
    return Array.from({length: this.rowCount}, (_, rowOffset) =>
      Array.from({length: this.columnCount}, (_, columnOffset) =>
        cloneValue(this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? '')
      )
    );
  }

  setValues(values) {
    if (this.sheet.failNextSetValues) {
      this.sheet.failNextSetValues = false;
      throw new Error(`injected write failure: ${this.sheet.name}`);
    }
    assert.equal(values.length, this.rowCount);
    values.forEach((rowValues, rowOffset) => {
      assert.equal(rowValues.length, this.columnCount);
      const rowIndex = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= rowIndex) this.sheet.rows.push([]);
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset++) {
        this.sheet.rows[rowIndex][this.column - 1 + columnOffset] = cloneValue(rowValues[columnOffset]);
      }
    });
  }

  setValue(value) {
    this.setValues([[value]]);
  }

  setNumberFormat() {}

  clearContent() {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset++) {
      const rowIndex = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= rowIndex) this.sheet.rows.push([]);
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset++) {
        this.sheet.rows[rowIndex][this.column - 1 + columnOffset] = '';
      }
    }
    this.sheet.trim();
  }
}

class MockSheet {
  constructor(rows, name = '') {
    this.rows = rows.map(row => row.map(cloneValue));
    this.name = name;
  }

  getLastRow() {
    this.trim();
    return this.rows.length;
  }

  getLastColumn() {
    return Math.max(0, ...this.rows.map(row => row.length));
  }

  getDataRange() {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), this.rows[0]?.length || 17);
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new MockRange(this, row, column, rowCount, columnCount);
  }

  setFrozenRows() {}

  getName() { return this.name; }

  trim() {
    while (this.rows.length > 1 && this.rows.at(-1).every(value => value === '' || value === null || value === undefined)) {
      this.rows.pop();
    }
  }
}

class MockSpreadsheet {
  constructor(id) {
    this.id = id;
    this.sheets = new Map();
  }

  getId() { return this.id; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  getSheets() { return [...this.sheets.values()]; }
  deleteSheet(sheet) {
    for (const [name, current] of this.sheets.entries()) {
      if (current === sheet) {
        this.sheets.delete(name);
        return;
      }
    }
  }
  insertSheet(name) {
    const sheet = new MockSheet([], name);
    this.sheets.set(name, sheet);
    return sheet;
  }
  addSheet(name, sheet) {
    sheet.name = name;
    this.sheets.set(name, sheet);
    return sheet;
  }
}

function cloneValue(value) {
  return value instanceof Date ? new Date(value.getTime()) : value;
}

const apiProject = path.resolve(__dirname, '..');
const sourceFiles = [
  'Code.gs',
  'ExtensionApi.gs',
  'ClassroomStorage.gs',
  'UnifiedInCampusStorage.gs',
  'ClassroomApiExperimentApi.gs',
  'ClassroomApiSync.gs',
  'ClassroomMailParsing.gs',
  'ClassroomIntegration.gs',
  'MailSync.gs',
  'NotificationFormatting.gs',
  'NotificationQueries.gs',
  'UniversityViewData.gs',
  'InCampusIntegration.gs',
  'InCampusMailParsing.gs'
];
const source = sourceFiles.map(file => fs.readFileSync(path.join(apiProject, file), 'utf8')).join('\n');
const propertyValues = Object.create(null);
const userProperties = {
  getProperty(key) { return Object.hasOwn(propertyValues, key) ? propertyValues[key] : null; },
  setProperty(key, value) { propertyValues[key] = String(value); return this; },
  deleteProperty(key) { delete propertyValues[key]; return this; },
  getProperties() { return {...propertyValues}; }
};
const spreadsheet = new MockSpreadsheet('private-sheet');
spreadsheet.addSheet('シート1', new MockSheet([]));
const sheet = spreadsheet.addSheet('補足通知', new MockSheet([]));
const emptySheet = spreadsheet.addSheet('inCampus通知', new MockSheet([]));
const legacyClassroomSheet = spreadsheet.addSheet('Classroom通知', new MockSheet([]));
const triggerState = {items: []};
const scriptApp = {
  getProjectTriggers: () => triggerState.items.slice(),
  deleteTrigger(trigger) { triggerState.items = triggerState.items.filter(item => item !== trigger); },
  newTrigger(handler) {
    const builder = {
      handler,
      timeBased() { return this; },
      everyHours(hours) { this.hours = hours; return this; },
      create() {
        const trigger = {handler: this.handler, hours: this.hours, getHandlerFunction() { return this.handler; }};
        triggerState.items.push(trigger);
        return trigger;
      }
    };
    return builder;
  }
};

const context = vm.createContext({
  Date,
  Map,
  Set,
  PropertiesService: {getUserProperties: () => userProperties},
  SpreadsheetApp: {flush() {}},
  ScriptApp: scriptApp,
  Session: {getScriptTimeZone: () => 'Asia/Tokyo'},
  Utilities: {formatDate(date, timeZone, format) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => (result[part.type] = part.value, result), {});
    if (format === 'yyyy/MM/dd') return `${parts.year}/${parts.month}/${parts.day}`;
    if (format === 'yyyy/MM/dd HH:mm') return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    if (format === 'HH:mm') return `${parts.hour}:${parts.minute}`;
    if (format === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
    return '';
  }},
  Logger: {log() {}}
});
vm.runInContext(source, context, {filename: 'classroom-api-sync-runtime.gs'});

let courses = [];
let courseworkByCourse = {};
const getConstant = name => vm.runInContext(name, context);
context.runWithUserLock_ = (_name, callback) => callback();
context.isTestCaseModeEnabled_ = () => false;
context.getOrCreateSpreadsheetLocked_ = () => spreadsheet;
context.getNotificationReadSheets_ = () => ({'Google Classroom': sheet, inCampus: emptySheet});
context.listClassroomApiExperimentCourses_ = () => courses;
context.listClassroomApiExperimentCoursework_ = courseId => {
  const value = courseworkByCourse[courseId];
  if (value instanceof Error) throw value;
  return value || [];
};
const submissionLookups = [];
const studentSubmissionByWorkId = Object.create(null);
context.Classroom = {
  UserProfiles: {get: userId => ({id: userId === 'me' ? 'student-current' : userId})},
  Courses: {
    Teachers: {list: () => ({teachers: [{profile: {name: {fullName: '仮想教員'}}}]})},
    Topics: {list: () => ({topic: [{topicId: 'topic-a', name: '第1回'}]})},
    CourseWork: {StudentSubmissions: {list(courseId, courseworkId, request) {
      submissionLookups.push({courseId, courseworkId, request});
      const value = studentSubmissionByWorkId[courseworkId];
      if (value instanceof Error) throw value;
      return {studentSubmissions: [value || {state: 'NEW'}]};
    }}}
  }
};

function notificationRow({
  messageId, source = 'Google Classroom', course = '仮想授業', title = '新課題',
  due = '2026/10/20 09:00', dueStatus = '抽出成功', body = '新しい課題\n課題を表示',
  status = '未確認', completedAt = '', link = ''
}) {
  return [new Date('2026-09-01T00:00:00Z'), messageId, source, course, title, due,
    dueStatus, title, 'classroom.google.com', new Date('2026-09-01T00:00:00Z'),
    link, body, status, completedAt, '', '', ''];
}

function sheetRows() {
  return context.getClassroomApiNotificationRowsForWeb_().concat(sheet.getDataRange().getValues().slice(1));
}

function visibleRows() {
  return context.getNotificationRowsFromSheets_({'Google Classroom': sheet, inCampus: emptySheet}, false, null);
}

function workbookSnapshot() {
  return [...spreadsheet.sheets.entries()].map(([name, current]) => [
    name,
    current.rows.map(row => row.map(cloneValue))
  ]);
}

const legacyExtractRow = [
  'inCampus', 'assignment', '仮想inCampus課題', '拡張機能からの仮想説明', '', '2026-10-08',
  '2026年10月8日まで', '', '', '', 'https://ic.ss.senshu-u.ac.jp/lms/course/report/SIM-0101',
  '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z',
  JSON.stringify({courseName: '仮想inCampus授業'}), '未確認', '', 'virtual-inCampus-key'
];
spreadsheet.addSheet('inCampus抽出', new MockSheet([
  Array.from(getConstant('INCAMPUS_HEADERS')),
  legacyExtractRow
]));

const originalAssignment = notificationRow({
  messageId: 'gmail-assignment-1',
  course: '仮想授業 A',
  title: '期限が修正される課題',
  due: '2026/10/19 18:00',
  status: '完了',
  completedAt: '2026/09/20 10:00',
  link: 'https://mail.google.com/mail/u/0/#all/gmail-assignment-1',
  body: '新しい課題\n期限が修正される課題\nhttps://classroom.google.com/c/course-a/a/work-1/details'
});
const announcement = notificationRow({
  messageId: 'gmail-announcement-1',
  title: '休講のお知らせ',
  body: '新しいお知らせ\n来週は休講です。'
});
legacyClassroomSheet.rows = [getConstant('HEADER_ROW').slice(), originalAssignment, announcement];
courses = [
  {id: 'course-a', name: '仮想授業 A', section: '火曜5限', courseState: 'ACTIVE', alternateLink: 'https://classroom.example.test/c/course-a'},
  {id: 'course-b', name: '仮想授業 B', section: '月曜2限', courseState: 'ACTIVE', alternateLink: 'https://classroom.example.test/c/course-b'}
];
courseworkByCourse = {
  'course-a': [{
    id: 'work-1', title: '期限が修正される課題', description: 'APIを正本にします。',
    workType: 'ASSIGNMENT', assigneeMode: 'ALL_STUDENTS', topicId: 'topic-a',
    materials: [{link: {url: 'https://example.test/virtual-material'}}],
    scheduledTime: '2026-10-01T00:00:00Z', creationTime: '2026-09-28T00:00:00Z',
    dueDate: {year: 2026, month: 10, day: 8}, dueTime: {hours: 14, minutes: 59},
    updateTime: '2020-01-01T00:00:00Z', alternateLink: 'https://classroom.google.com/c/course-a/a/work-1/details'
  }],
  'course-b': [{
    id: 'work-2', title: '期限なし課題', updateTime: '2020-01-02T00:00:00Z',
    alternateLink: 'https://classroom.google.com/c/course-b/a/work-2/details'
  }]
};
studentSubmissionByWorkId['work-1'] = {
  userId: 'student-current', state: 'NEW'
};

const firstSync = context.syncClassroomApiCourseworkToSpreadsheet_();
assert.equal(firstSync.courseCount, 2);
assert.equal(firstSync.courseworkCount, 2);
let rows = sheetRows();
assert.equal(rows.length, 4, 'the API tasks and original Gmail assignment/announcement remain stored');
let apiTask = rows.find(row => row[1] === 'classroom-api:course-a:work-1');
assert.ok(apiTask, 'API task is stored with a stable course/work ID');
assert.equal(apiTask[5], '2026/10/08 23:59', '14:59 UTC is saved as 23:59 Japan time');
assert.equal(apiTask[12], '未確認', 'a Gmail completion notice does not beat the API NEW state');
assert.equal(apiTask[14], 'classroom-api-submission');
assert.equal(apiTask[15], 'NEW');
assert.equal(firstSync.retainedAssignmentEmailCount, 1);
const visibleApiMatch = visibleRows().filter(row => row[1] === 'classroom-api:course-a:work-1');
assert.equal(visibleApiMatch.length, 1, 'matching Gmail and API records render as one card');
assert.equal(visibleApiMatch[0][5], '2026/10/08 23:59', 'the API deadline wins over the different Gmail deadline');
assert.equal(visibleApiMatch[0][10], 'https://mail.google.com/mail/u/0/#all/gmail-assignment-1', 'the API-owned card keeps the Gmail source link');
assert.equal(visibleApiMatch[0][17], 'gmail-assignment-1', 'the card carries the original Gmail message ID');
const visibleApiItem = context.rowToNotificationItem_(visibleApiMatch[0]);
assert.equal(visibleApiItem.gmailLink, 'https://mail.google.com/mail/u/0/#all/gmail-assignment-1');
assert.equal(visibleApiItem.gmailMessageId, 'gmail-assignment-1');
assert.equal(visibleApiItem.gmailReceivedAt, '2026/09/01 09:00', 'the merged card shows the original Gmail receive time');
const unmatchedAssignmentMail = notificationRow({
  messageId: 'gmail-assignment-not-yet-in-api', course: '仮想授業 C', title: 'API未同期の課題',
  body: '新しい課題\nAPIの次回同期前に表示する仮想課題です。\nhttps://classroom.google.com/c/course-c/a/work-c/details'
});
context.appendNotificationRows_(sheet, [unmatchedAssignmentMail]);
assert.ok(visibleRows().some(row => row[1] === 'gmail-assignment-not-yet-in-api'),
  'an assignment email without an API match is visible during the fast Gmail first pass');
assert.deepEqual([...spreadsheet.sheets.keys()].sort(), [
  'Classroom通知', 'Classroom課題', 'inCampus通知', '提出状況', '補足通知', '授業'
].sort(), 'the structured API sync creates the five requested data tabs and preserves the old Classroom tab');
assert.equal(spreadsheet.getSheetByName('inCampus抽出'), null, 'the old extraction tab is removed only after its rows migrate');
const unifiedInCampusSheet = spreadsheet.getSheetByName('inCampus通知');
assert.deepEqual(unifiedInCampusSheet.getRange(1, 1, 1, getConstant('INCAMPUS_UNIFIED_HEADERS').length).getValues()[0],
  Array.from(getConstant('INCAMPUS_UNIFIED_HEADERS')));
const inCampusExtractAdapter = context.getOrCreateInCampusSheet_();
assert.equal(inCampusExtractAdapter.getLastRow(), 2, 'the extension reader sees migrated extract rows through its adapter');
assert.equal(inCampusExtractAdapter.getDataRange().getValues()[1][10], legacyExtractRow[10]);
const inCampusGmailRow = notificationRow({
  messageId: 'incampus-gmail-1', source: 'inCampus', course: '仮想inCampus授業', title: '仮想inCampus課題',
  body: '課題が追加されました。', link: 'https://mail.google.com/mail/u/0/#all/incampus-gmail-1'
});
context.appendNotificationRows_(unifiedInCampusSheet, [inCampusGmailRow]);
assert.equal(unifiedInCampusSheet.getLastRow(), 3, 'Gmail and extension records coexist in one physical sheet');
assert.equal(unifiedInCampusSheet.getRange(3, getConstant('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN') + 1).getValues()[0][0], 'gmail');
const extensionUpsert = context.upsertInCampusAssignment_({
  source: 'inCampus', type: 'assignment', title: '仮想inCampus課題', body: '拡張機能の最新抽出内容',
  pageUrl: legacyExtractRow[10], dueAt: '2026-10-09', extractedAt: '2026-10-01T00:00:00.000Z',
  assignmentKey: 'virtual-inCampus-key'
});
assert.equal(extensionUpsert.updated, true, 'extension updates still target the extraction record inside the unified tab');
assert.equal(context.getOrCreateInCampusSheet_().getDataRange().getValues()[1][3], '拡張機能の最新抽出内容');
assert.ok(unifiedInCampusSheet.getDataRange().getValues().some(row => row[1] === 'incampus-gmail-1'), 'extension upsert leaves the original Gmail record intact');
const expiredInCampusGmailRow = notificationRow({
  messageId: 'incampus-gmail-expired', source: 'inCampus', title: '古い仮想通知', body: '古い通知'
});
expiredInCampusGmailRow[9] = new Date(Date.now() - 200 * 86400000);
context.appendNotificationRows_(unifiedInCampusSheet, [expiredInCampusGmailRow]);
const futureRecord = Array(getConstant('INCAMPUS_UNIFIED_HEADERS').length).fill('');
futureRecord[getConstant('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN')] = 'futureRecordType';
futureRecord[futureRecord.length - 1] = 'future data to preserve';
unifiedInCampusSheet.getRange(unifiedInCampusSheet.getLastRow() + 1, 1, 1, futureRecord.length).setValues([futureRecord]);
context.normalizeNotificationSheet_(unifiedInCampusSheet, context.getNotificationStorageConfigForSource_('inCampus'));
assert.equal(context.getOrCreateInCampusSheet_().getLastRow(), 2, 'Gmail retention never removes the extension extraction record');
assert.ok(unifiedInCampusSheet.getDataRange().getValues().some(row => row.includes('future data to preserve')),
  'Gmail cleanup preserves records with unknown future types');
const inCampusReadRows = context.getNotificationRowsFromSheets_({'Google Classroom': sheet, inCampus: unifiedInCampusSheet}, false, null);
assert.ok(inCampusReadRows.some(row => row[1] === 'incampus-gmail-1'));
assert.ok(!inCampusReadRows.some(row => row[1] === 'incampus-gmail-expired'), 'the unified mail reader still applies Gmail retention');
assert.ok(!inCampusReadRows.some(row => row[1] === 'virtual-inCampus-key'), 'extension extraction rows are not mistaken for Gmail notifications');
assert.equal(spreadsheet.getSheetByName('シート1'), null, 'an empty localized default sheet is removed after the requested data tabs exist');
const storedCoursework = spreadsheet.getSheetByName('Classroom課題').getDataRange().getValues();
assert.deepEqual(storedCoursework[0], Array.from(getConstant('CLASSROOM_COURSEWORK_HEADERS')));
const storedApiTask = storedCoursework.slice(1).find(row => row[1] === 'work-1');
assert.equal(storedApiTask.length, 21);
assert.equal(storedApiTask[2], '仮想授業 A');
assert.equal(storedApiTask[5], 'ASSIGNMENT');
assert.equal(storedApiTask[7], '["https://example.test/virtual-material"]');
assert.equal(storedApiTask[9], '第1回');
assert.equal(storedApiTask[10], '2026-10-01T00:00:00Z');
assert.equal(storedApiTask[11], '2026-09-28T00:00:00Z');
assert.equal(storedApiTask[14], '23:59');
const storedCourseRows = spreadsheet.getSheetByName('授業').getDataRange().getValues();
assert.deepEqual(storedCourseRows[0], Array.from(getConstant('CLASSROOM_COURSE_HEADERS')));
assert.equal(storedCourseRows[1][1], '仮想授業 A');
assert.equal(storedCourseRows[1][2], '火曜5限');
assert.equal(storedCourseRows[1][3], '仮想教員');
assert.equal(storedCourseRows[1][4], 'https://classroom.example.test/c/course-a');
const storedSubmissionRows = spreadsheet.getSheetByName('提出状況').getDataRange().getValues();
assert.deepEqual(storedSubmissionRows[0], Array.from(getConstant('CLASSROOM_SUBMISSION_HEADERS')));
assert.equal(storedSubmissionRows[1][4], 'NEW');
assert.equal(storedSubmissionRows[1][6], false);
// Google Sheets can coerce written date/time strings into Date objects.
// Exercise the real read path with those returned cell types.
const storedCourseworkSheet = spreadsheet.getSheetByName('Classroom課題');
storedCourseworkSheet.getRange(2, 14, 1, 1).setValue(new Date('2026-10-07T15:00:00.000Z'));
storedCourseworkSheet.getRange(2, 15, 1, 1).setValue(new Date('1899-12-30T14:59:00.000Z'));
const normalizedSheetDateTask = context.getClassroomApiNotificationRowsForWeb_()
  .find(row => row[1] === 'classroom-api:course-a:work-1');
assert.equal(normalizedSheetDateTask[5], '2026/10/08 23:59', 'date/time cells coerced by Sheets still display the correct Japan-local deadline');
assert.ok(spreadsheet.getSheetByName('補足通知').getDataRange().getValues().slice(1).some(row => row[1] === 'gmail-announcement-1'));
assert.equal(legacyClassroomSheet.getDataRange().getValues().length, 3, 'legacy source data remains as a recoverable archive');
assert.equal(firstSync.submittedCourseworkCount, 0);
assert.ok(submissionLookups[0].request.fields.includes('userId'), 'the API returns user IDs so sync can select the signed-in user row');
assert.equal(submissionLookups.length, 2, 'the API sync reads the signed-in student state for each assigned task');
studentSubmissionByWorkId['work-1'] = {
  userId: 'student-current', state: 'RETURNED',
  submissionHistory: [{stateHistory: {state: 'TURNED_IN', stateTimestamp: '2026-09-20T10:00:00.000Z'}}]
};
context.syncClassroomApiCourseworkToSpreadsheet_();
rows = sheetRows();
apiTask = rows.find(row => row[1] === 'classroom-api:course-a:work-1');
assert.equal(apiTask[12], '完了', 'TURNED_IN/RETURNED API state completes the task');
assert.equal(apiTask[13], '2026-09-20T10:00:00.000Z', 'the API submission history supplies the completion date');
assert.equal(apiTask[14], 'classroom-api-submission');
assert.equal(apiTask[15], 'RETURNED');
const completedActiveItems = context.getActiveNotificationItemsForWebLocked_(null, null, null);
assert.ok(!completedActiveItems.some(item => item.messageId === 'classroom-api:course-a:work-1'), 'an API-submitted task is excluded from the unfinished list');
assert.equal(submissionLookups.length, 4);
const mixedClassroomRows = [getConstant('HEADER_ROW').slice(), ...sheet.getDataRange().getValues().slice(1), ...context.getClassroomApiNotificationRowsForWeb_()];
const gmailCompletion = context.completeMatchingClassroomNotificationRow_(sheet, mixedClassroomRows, {
  courseId: 'course-a', streamItemId: 'work-1', courseName: '仮想授業 A',
  title: '期限が修正される課題', classroomUrl: 'https://classroom.google.com/c/course-a/a/work-1/details'
});
assert.equal(gmailCompletion.matched, false, 'Gmail submission notices cannot override API-owned submission state');
assert.match(gmailCompletion.reason, /API/);
assert.equal(context.chooseClassroomApiRecordState_(
  notificationRow({messageId: 'classroom-api:course-a:work-1',status: '完了'}),
  {state: 'NEW'}
).status, '未確認', 'the API clears completion inferred from a prior Gmail row when Classroom says not submitted');
assert.equal(context.chooseClassroomApiRecordState_(null, {state: 'TURNED_IN'}).status, '完了');
assert.equal(context.chooseClassroomApiRecordState_(null, {state: 'STUDENT_EDITED_AFTER_TURN_IN'}).status, '完了', 'edited-after-turn-in remains submitted');
assert.equal(context.selectClassroomApiExperimentCurrentStudentSubmission_([
  {userId: 'student-other', state: 'NEW'},
  {userId: 'student-current', state: 'TURNED_IN'}
], 'student-current').state, 'TURNED_IN', 'submission selection matches the signed-in student even when their row is not first');
assert.throws(() => context.selectClassroomApiExperimentCurrentStudentSubmission_([
  {userId: 'student-other', state: 'NEW'}
], 'student-current'), /利用者IDが現在のClassroom利用者と一致しません/);
assert.equal(context.chooseClassroomApiRecordState_(
  notificationRow({messageId: 'classroom-api:course-a:work-1',status: '完了',body:''}).map((value,index)=>index===14?'classroom-api-submission':value),
  {state: 'RECLAIMED_BY_STUDENT'}
).status, '未確認', 'reclaimed work returns to the active list');
assert.equal(context.chooseClassroomApiRecordState_(
  null,
  {state: 'NEW'}
).status, '未確認', 'the API state wins over an unmatched Gmail-derived completion state');
assert.equal(context.chooseClassroomApiRecordState_(
  notificationRow({messageId: 'classroom-api:course-a:work-1',status: '完了', body: ''}).map((value,index)=>index===14?'manual-status':value),
  {state: 'NEW'}
).status, '完了', 'a user-marked completion remains distinct from API submission status');
assert.ok(rows.some(row => row[1] === 'gmail-announcement-1'), 'API-missing Gmail notices are preserved');
assert.ok(rows.some(row => row[1] === 'gmail-assignment-1'), 'Gmail assignment source is retained after an API snapshot');
assert.ok(rows.some(row => row[1] === 'gmail-assignment-not-yet-in-api'), 'a Gmail-first assignment remains stored after API sync');
assert.ok(rows.some(row => row[1] === 'classroom-api:course-b:work-2'), 'an old API updateTime is not removed by Gmail retention');
const extensionDueResult = context.updateMatchingClassroomDueTimeRow_(sheet, mixedClassroomRows, {
  courseId: 'course-a', streamItemId: 'work-1', courseName: '仮想授業 A',
  title: '期限が修正される課題', classroomUrl: 'https://classroom.google.com/c/course-a/a/work-1/details',
  dueDate: '2026-10-26', dueTime: '13:00'
});
assert.equal(extensionDueResult.matched, false, 'extension due corrections cannot mutate API-owned task data');
assert.match(extensionDueResult.reason, /Classroom API/);
assert.equal(context.shouldSkipClassroomAssignmentMail_('Google Classroom', '新しい課題'), false);
assert.equal(context.shouldSkipClassroomAssignmentMail_('Google Classroom', '新しいお知らせ'), false);
assert.equal(context.isTaskRelatedRow_(apiTask), true, 'API coursework appears in task queries regardless of title keywords');

const unsafeMigrationSheet = new MockSpreadsheet('unsafe-migration-sheet');
const unsafeHeader = [...getConstant('HEADER_ROW'), 'UnknownColumn'];
unsafeMigrationSheet.addSheet('inCampus通知', new MockSheet([unsafeHeader,
  [...inCampusGmailRow, 'must not be discarded']]));
assert.throws(() => context.getOrCreateInCampusUnifiedSheetLocked_(unsafeMigrationSheet), /未対応の列またはデータ/);
assert.equal(unsafeMigrationSheet.getSheetByName('inCampus通知').rows[1].at(-1), 'must not be discarded',
  'schema upgrades fail closed when the old tab has extra data');

const successfulRows = workbookSnapshot();
const lastSuccessProperty = getConstant('CLASSROOM_API_LAST_SUCCESS_PROPERTY');
const apiLastErrorProperty = getConstant('CLASSROOM_API_LAST_ERROR_PROPERTY');
const lastSuccess = userProperties.getProperty(lastSuccessProperty);
spreadsheet.getSheetByName('Classroom課題').failNextSetValues = true;
assert.throws(() => context.syncClassroomApiCourseworkToSpreadsheet_(), /injected write failure/);
assert.deepEqual(workbookSnapshot(), successfulRows, 'a sheet-write failure rolls back the partial multi-tab update');
assert.equal(userProperties.getProperty(getConstant('CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY')), null);
courseworkByCourse = {'course-a': courseworkByCourse['course-a'], 'course-b': new Error('temporary permission failure')};
assert.throws(() => context.syncClassroomApiCourseworkToSpreadsheet_(), /仮想授業 B/);
assert.deepEqual(workbookSnapshot(), successfulRows, 'a partial API failure does not partially overwrite the authoritative snapshot');
assert.equal(userProperties.getProperty(lastSuccessProperty), lastSuccess);
assert.match(userProperties.getProperty(apiLastErrorProperty), /temporary permission failure/);

courseworkByCourse = {
  'course-a': courseworkByCourse['course-a'],
  'course-b': [{id: 'work-2', title: '期限なし課題', updateTime: '2020-01-02T00:00:00Z', alternateLink: 'https://classroom.google.com/c/course-b/a/work-2/details'}]
};
studentSubmissionByWorkId['work-1'] = new Error('temporary submission status failure');
assert.throws(() => context.syncClassroomApiCourseworkToSpreadsheet_(), /提出状況.*temporary submission status failure/);
assert.deepEqual(workbookSnapshot(), successfulRows, 'a submission-state failure leaves the previous snapshot intact');
delete studentSubmissionByWorkId['work-1'];

courses = [];
courseworkByCourse = {};
const emptySnapshot = context.syncClassroomApiCourseworkToSpreadsheet_();
assert.equal(emptySnapshot.courseworkCount, 0);
rows = sheetRows();
assert.equal(rows.length, 3, 'a successful empty snapshot removes stale API tasks but retains all Gmail records');
assert.ok(rows.some(row => row[1] === 'gmail-announcement-1'));
assert.ok(rows.some(row => row[1] === 'gmail-assignment-1'));
assert.ok(rows.some(row => row[1] === 'gmail-assignment-not-yet-in-api'));

const fixedNow = new Date('2026-10-05T00:00:00.000Z');
const dueRetentionItem = {
  dueDate: {year: 2026, month: 9, day: 20},
  dueTime: {hours: 14, minutes: 59}
};
assert.equal(
  context.isClassroomApiCourseworkExpiredForRetention_(dueRetentionItem, new Date('2026-10-04T14:59:59.999Z')),
  false,
  'dated coursework remains through the exact 14-day retention boundary'
);
assert.equal(
  context.isClassroomApiCourseworkExpiredForRetention_(dueRetentionItem, new Date('2026-10-04T15:00:00.000Z')),
  true,
  'dated coursework expires immediately after 14 full days past its JST deadline'
);
const midnightDueRetentionItem = {dueDate: {year: 2026, month: 9, day: 20}, dueTime: {hours: 15, minutes: 0}};
assert.equal(
  context.isClassroomApiCourseworkExpiredForRetention_(midnightDueRetentionItem, new Date('2026-10-04T14:59:59.999Z')),
  false,
  'a midnight deadline uses the prior JST day at 23:59 for its retention boundary'
);
assert.equal(
  context.isClassroomApiCourseworkExpiredForRetention_(midnightDueRetentionItem, new Date('2026-10-04T15:00:00.000Z')),
  true
);
const undatedRetentionItem = {creationTime: '2026-09-01T00:00:00.000Z'};
assert.equal(
  context.isClassroomApiCourseworkExpiredForRetention_(undatedRetentionItem, new Date('2026-09-22T00:00:00.000Z')),
  false,
  'undated coursework remains through the exact 21-day retention boundary'
);
assert.equal(
  context.isClassroomApiCourseworkExpiredForRetention_(undatedRetentionItem, new Date('2026-09-22T00:00:00.001Z')),
  true,
  'undated coursework expires after 21 days from publication/creation'
);
const apiNoDueAtBoundary = {
  messageId: 'classroom-api:course:no-due', dueType: 'none',
  receivedAtTime: Date.parse('2026-09-14T00:00:00.000Z')
};
assert.equal(
  context.isStaleUnknownDueNotificationForWeb_(apiNoDueAtBoundary, new Date('2026-10-05T00:00:00.000Z')),
  false,
  'no-deadline API task stays visible through 21 days'
);
assert.equal(
  context.isStaleUnknownDueNotificationForWeb_(apiNoDueAtBoundary, new Date('2026-10-05T00:00:00.001Z')),
  true,
  'no-deadline API task is hidden once it passes 21 days'
);
assert.equal(
  context.isNotYetPublishedClassroomApiNotificationForWeb_({...apiNoDueAtBoundary, receivedAtTime: fixedNow.getTime() + 1}, fixedNow),
  true,
  'scheduled API coursework is hidden until its release time'
);

courses = [{id: 'course-retention', name: '仮想授業 D', courseState: 'ACTIVE'}];
courseworkByCourse = {'course-retention': [
  {id: 'due-expired', title: '期限あり期限切れ', dueDate: {year: 2026, month: 9, day: 1}, dueTime: {hours: 23, minutes: 59}},
  {id: 'no-due-expired', title: '期限なし21日超過', creationTime: '2026-09-01T00:00:00.000Z'},
  {id: 'no-due-recent', title: '期限なし21日以内', creationTime: '2026-09-25T00:00:00.000Z', updateTime: '2026-10-01T00:00:00.000Z'},
  {id: 'individual-assigned', title: '本人に個人指定', assigneeMode: 'INDIVIDUAL_STUDENTS', individualStudentsOptions: {studentIds: ['student-current']}, creationTime: '2026-09-25T00:00:00.000Z'},
  {id: 'individual-unassigned', title: '他人に個人指定', assigneeMode: 'INDIVIDUAL_STUDENTS', individualStudentsOptions: {studentIds: ['student-other']}, creationTime: '2026-09-25T00:00:00.000Z'}
]};
const manualRetentionCheck = context.syncClassroomApiCourseworkToSpreadsheet_({referenceNow: fixedNow});
assert.equal(manualRetentionCheck.applyRetention, false, 'manual synchronization does not run retention cleanup');
assert.equal(manualRetentionCheck.fetchedCourseworkCount, 5);
assert.equal(manualRetentionCheck.excludedUnassignedCourseworkCount, 1);
assert.equal(manualRetentionCheck.courseworkCount, 4);
assert.ok(sheetRows().some(row => row[1] === 'classroom-api:course-retention:due-expired'), 'manual sync keeps an expired row until scheduled cleanup');
assert.ok(sheetRows().some(row => row[1] === 'classroom-api:course-retention:no-due-expired'), 'manual sync keeps old no-deadline rows until scheduled cleanup');
assert.ok(sheetRows().some(row => row[1] === 'classroom-api:course-retention:individual-assigned'), 'a task individually assigned to the current student is included');
assert.ok(!sheetRows().some(row => row[1] === 'classroom-api:course-retention:individual-unassigned'), 'a task assigned to another student is excluded');
assert.equal(new Date(sheetRows().find(row=>row[1]==='classroom-api:course-retention:no-due-recent')[9]).toISOString(), '2026-09-25T00:00:00.000Z', 'an edit time does not reset the no-deadline retention age');
const scheduledRetentionResult = context.syncClassroomApiCourseworkOnSchedule_(fixedNow);
assert.equal(scheduledRetentionResult.applyRetention, true);
assert.equal(scheduledRetentionResult.removedExpiredCourseworkCount, 2);
assert.equal(scheduledRetentionResult.courseworkCount, 2);
rows = sheetRows();
assert.ok(!rows.some(row => row[1] === 'classroom-api:course-retention:due-expired'), 'hourly sync removes coursework 14 days after its deadline');
assert.ok(!rows.some(row => row[1] === 'classroom-api:course-retention:no-due-expired'), 'hourly sync removes no-deadline coursework after 21 days');
assert.ok(rows.some(row => row[1] === 'classroom-api:course-retention:no-due-recent'));
assert.ok(rows.some(row => row[1] === 'classroom-api:course-retention:individual-assigned'));
assert.ok(!rows.some(row => row[1] === 'classroom-api:course-retention:individual-unassigned'));
const triggerResult = context.ensureClassroomApiTrigger_();
assert.equal(triggerResult.created, true);
assert.equal(triggerState.items.length, 1);
assert.equal(triggerState.items[0].handler, 'syncClassroomApiCourseworkOnSchedule_');
assert.equal(triggerState.items[0].hours, 1);
assert.equal(context.ensureClassroomApiTrigger_().created, false, 'repeated startup does not create duplicate hourly triggers');
assert.equal(triggerState.items.length, 1);

context.Classroom = {
  UserProfiles: {get: userId => ({id: userId === 'me' ? 'student-current' : userId})},
  Courses: {
    Teachers: {list: () => ({teachers: [{profile: {name: {fullName: '山田 花子'}}}]})},
    Topics: {list: () => ({topic: [{topicId: 'topic-1', name: '第1回'}]})},
    CourseWork: {
      StudentSubmissions: {list: () => ({studentSubmissions: [{
        state: 'RETURNED', late: true, assignedGrade: 8,
        submissionHistory: [
          {stateHistory: {state: 'TURNED_IN', stateTimestamp: '2026-10-02T01:00:00Z'}},
          {stateHistory: {state: 'RETURNED', stateTimestamp: '2026-10-03T01:00:00Z'}}
        ],
        assignmentSubmission: {attachments: [{title: 'private-file'}]},
        shortAnswerSubmission: {answer: 'private response'}
      }]})}
    }
  }
};
courses = [{id: 'course-export', name: '仮想授業 C', section: '火曜5限', courseState: 'ACTIVE', alternateLink: 'https://classroom.google.com/c/course-export'}];
courseworkByCourse = {'course-export': [{
  id: 'work-export', title: '日付だけの課題', description: 'API出力のテスト', workType: 'ASSIGNMENT',
  materials: [{link: {url: 'https://example.test/material'}}], topicId: 'topic-1',
  scheduledTime: '2026-10-01T00:00:00Z', creationTime: '2026-09-20T00:00:00Z', updateTime: '2026-10-01T00:00:00Z',
  dueDate: {year: 2026, month: 10, day: 5}, alternateLink: 'https://classroom.google.com/c/course-export/a/work-export/details'
}]};
let gmailWasCalled = false;
context.saveClassroomMailsToSheet = () => { gmailWasCalled = true; throw new Error('Gmail must not be called'); };
const actualSyncFunction = context.syncClassroomApiCourseworkToSpreadsheet_;
context.syncClassroomApiCourseworkToSpreadsheet_ = () => ({courseCount: 1, courseworkCount: 1, submittedCourseworkCount: 1});
const syncOnlyResult = context.syncClassroomApiOnlyForExperimentWeb();
assert.equal(syncOnlyResult.ok, true);
assert.equal(syncOnlyResult.gmailCalled, false);
assert.equal(gmailWasCalled, false, 'the API-only save endpoint never calls Gmail');
context.syncClassroomApiCourseworkToSpreadsheet_ = actualSyncFunction;
const workbookData = context.getClassroomApiExperimentWorkbookDataForWeb();
assert.equal(workbookData.ok, true);
assert.equal(workbookData.courseCount, 1);
assert.equal(workbookData.courseworkCount, 1);
assert.equal(workbookData.submissionCount, 1);
assert.equal(workbookData.courses[0].teacherNames[0], '山田 花子');
assert.equal(workbookData.coursework[0].topicName, '第1回');
assert.equal(workbookData.coursework[0].dueTime, '23:59', 'date-only API deadlines default to 23:59');
assert.equal(workbookData.coursework[0].dueTimeSource, 'APIに時刻なしのため23:59');
assert.equal(workbookData.submissions[0].submittedAt, '2026-10-02T01:00:00Z');
assert.equal(workbookData.submissions[0].returned, true);
assert.equal(workbookData.submissions[0].assignedGrade, 8);
assert.equal(workbookData.savedToSpreadsheet, false);
assert.equal(workbookData.gmailCalled, false);
assert.equal(JSON.stringify(workbookData).includes('private response'), false, 'submission answers never enter the export');
assert.equal(JSON.stringify(workbookData).includes('private-file'), false, 'submission files never enter the export');
assert.equal(gmailWasCalled, false, 'the API workbook export never calls Gmail');

const order = [];
context.syncClassroomApiCourseworkToSpreadsheet_ = () => { order.push('api'); throw new Error('API failed'); };
context.saveClassroomMailsToSheet = () => { order.push('gmail'); return {savedCount: 2}; };
const orchestration = context.syncClassroomApiThenGmail_();
assert.deepEqual(order, ['api', 'gmail'], 'manual sync always finishes the API attempt before Gmail');
assert.match(orchestration.apiError, /API failed/);
assert.equal(orchestration.gmailSuccess, true, 'Gmail supplemental sync still runs after an API error');

console.log('Classroom API sync, authority, failure-safety, and hourly-trigger tests passed');
