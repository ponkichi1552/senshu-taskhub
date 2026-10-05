// Offline regression tests. Uses the real GAS functions and a rectangular sheet,
// persistent user properties, exclusive lock and Gmail mocks. No network access.
process.env.TZ = 'Asia/Tokyo';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
const gasSourceDir = path.join(base, 'taskhub-split/taskhub-split');
const gasFiles = fs.readdirSync(gasSourceDir).filter(name => name.endsWith('.gs'))
  .sort((a, b) => a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a.localeCompare(b));
const source = gasFiles.map(name => fs.readFileSync(path.join(gasSourceDir, name), 'utf8')).join('\n');
const results = [];
const clone = value => value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone) : value;
function check(name, fn) {try {fn(); results.push({name, passed: true});} catch (error) {results.push({name, passed: false, error: error.stack});}}
class Sheet {
  constructor(name, rows = []) {this.name = name; this.rows = clone(rows); this.writes = 0; this.dataRangeCalls = 0; this.maxRows = Math.max(100, rows.length); this.frozen = 0; this.onRead = null;}
  getName() {return this.name;}
  getSheetId() {return 1;}
  getLastRow() {let n = this.rows.length; while (n && this.rows[n - 1].every(v => v === '' || v == null)) n--; return n;}
  getLastColumn() {return Math.max(0, ...this.rows.map(r => r.length));}
  getDataRange() {this.dataRangeCalls++; return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));}
  getRange(r, c, h = 1, w = 1) {
    const sheet = this;
    return {
      getValues() {const output = Array.from({length: h}, (_, i) => Array.from({length: w}, (_, j) => clone(sheet.rows[r + i - 1]?.[c + j - 1] ?? ''))); if (sheet.onRead) {const f = sheet.onRead; sheet.onRead = null; f();} return output;},
      setValues(values) {assert.equal(values.length, h); for (const row of values) assert.equal(row.length, w); sheet.writes++; for (let i = 0; i < h; i++) {sheet.rows[r + i - 1] ||= []; for (let j = 0; j < w; j++) sheet.rows[r + i - 1][c + j - 1] = clone(values[i][j]);} return this;},
      setValue(value) {assert.equal(h, 1); assert.equal(w, 1); return this.setValues([[value]]);},
      clearContent() {return this.setValues(Array.from({length: h}, () => Array(w).fill('')));},
      setFontWeight() {return this;}
    };
  }
  appendRow(row) {this.rows.push(clone(row)); this.writes++;}
  deleteRows(start, count) {this.rows.splice(start - 1, count); this.writes++;}
  insertRowsAfter(start, count) {this.maxRows += count;}
  setFrozenRows(n) {this.frozen = n;}
  getFrozenRows() {return this.frozen;}
  getMaxRows() {return this.maxRows;}
  autoResizeColumns() {throw new Error('Read must not auto-resize');}
}
function environment(shared) {
  const state = shared || {held: false, acquisitions: 0, releases: 0, flushes: 0, props: {}, scriptProps: {}, sheets: {}, testSheets: {}, triggers: [], gmail: [], gmailSearches: 0, gmailQueries: [], userPropertyGetCalls: 0, userPropertiesSnapshotCalls: 0, spreadsheetOpenCalls: {}, spreadsheetCreateCalls: 0, logs: []};
  state.spreadsheetCreateCalls ||= 0;
  state.logs ||= [];
  const ss = {getId: () => 'test-sheet', getUrl: () => 'mock://test-sheet', getSheetByName: name => state.sheets[name] || null,
    insertSheet(name) {return state.sheets[name] = new Sheet(name);}, deleteSheet(sheet) {delete state.sheets[sheet.name];}};
  const testSs = {getId: () => 'test-case-sheet', getUrl: () => 'mock://test-case-sheet', getSheetByName: name => state.testSheets[name] || null,
    insertSheet(name) {return state.testSheets[name] = new Sheet(name);}, deleteSheet(sheet) {delete state.testSheets[sheet.name];}};
  const props = {getProperty(name) {state.userPropertyGetCalls++; return state.props[name] || null;}, setProperty(name, value) {state.props[name] = value;}, deleteProperty(name) {delete state.props[name];}, getProperties() {state.userPropertiesSnapshotCalls++; return {...state.props};}};
  const scriptProps = {getProperty: name => state.scriptProps[name] || null, setProperty(name, value) {state.scriptProps[name] = value;}, deleteProperty(name) {delete state.scriptProps[name];}, getProperties: () => ({...state.scriptProps})};
  const c = vm.createContext({Date, Set, Map, console, Logger: {log(message) {state.logs.push(String(message));}},
    SpreadsheetApp: {openById(id) {state.spreadsheetOpenCalls[id]=(state.spreadsheetOpenCalls[id]||0)+1;if (id === 'test-case-sheet') return testSs; if (id === 'test-sheet') return ss; throw new Error('not found');}, create() {state.spreadsheetCreateCalls++; return ss;}, flush() {state.flushes++;}},
    PropertiesService: {getUserProperties: () => props, getScriptProperties: () => scriptProps},
    LockService: {getUserLock() {return {tryLock() {if (state.held) return false; state.held = true; state.acquisitions++; return true;}, releaseLock() {assert.ok(state.held); state.held = false; state.releases++;}};}},
    Session: {getScriptTimeZone: () => 'Asia/Tokyo'},
      Utilities: {DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'}, computeDigest: (_, value) => [...crypto.createHash('sha256').update(String(value)).digest()],
      getUuid: () => crypto.randomUUID(), formatDate(value, zone, pattern) {const d = new Date(value), p = x => String(x).padStart(2, '0'); const date = `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())}`; const isoDate = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; const full = `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; if (pattern === "yyyy-MM-dd'T'HH:mm") return `${isoDate}T${p(d.getHours())}:${p(d.getMinutes())}`; if (pattern === 'yyyy-MM-dd') return isoDate; if (pattern === 'yyyy/MM/dd') return date; return pattern.endsWith(':ss') ? full : full.slice(0, 16);}},
    ScriptApp: {
      WeekDay: {SUNDAY: 'SUNDAY'},
      getProjectTriggers: () => state.triggers,
      deleteTrigger(trigger) {state.triggers = state.triggers.filter(item => item !== trigger);},
      newTrigger(handler) {const trigger = {handler, revision: 'current', getHandlerFunction() {return handler;}}; return {timeBased() {return this;}, everyMinutes(minutes) {trigger.minutes = minutes; return this;}, everyHours(hours) {trigger.hours = hours; return this;}, everyWeeks(weeks) {trigger.weeks = weeks; return this;}, onWeekDay(weekday) {trigger.weekday = weekday; return this;}, atHour(hour) {trigger.hour = hour; return this;}, create() {state.triggers.push(trigger); return trigger;}};}
    },
    GmailApp: {search(query, offset, count) {state.gmailSearches++; state.gmailQueries.push({query, offset, count}); if (state.onGmailSearch) {const callback = state.onGmailSearch; state.onGmailSearch = null; callback();} return state.gmail.filter(t => query.includes(t.source === 'inCampus' ? 'incampus' : 'classroom.google.com')).slice(offset, offset + count);}},
    ContentService: {MimeType: {JSON: 'JSON'}, createTextOutput(value) {return {value, setMimeType() {return this;}};}}
  });
  vm.runInContext(source, c);
  return {c, state, ss, testSs, add(name, rows) {return state.sheets[name] = new Sheet(name, rows);}, addTest(name, rows) {return state.testSheets[name] = new Sheet(name, rows);}, headers: [...vm.runInContext('HEADER_ROW', c)], inHeaders: [...vm.runInContext('INCAMPUS_HEADERS', c)]};
}
function prepareTestSpreadsheet(env) {
  const testNotificationHeaders = env.headers;
  const testExtractHeaders = env.inHeaders;
  env.addTest('Classroom通知', [env.headers]);
  env.addTest('inCampus通知', [env.headers]);
  env.addTest('inCampus抽出', [env.inHeaders]);
  env.addTest('テスト設定', [
    ['課題通知Hub テスト設定', ''],
    ['テスト開始日時', 'アプリ読込時'],
    ['元データの目標位置', '今日まで'],
    ['元の基準期限', new Date(2026, 8, 10)]
  ]);
  env.addTest('テストClassroom', [testNotificationHeaders]);
  env.addTest('テストinCampus', [testNotificationHeaders]);
  env.addTest('テスト抽出', [testExtractHeaders]);
  env.state.scriptProps.TASKHUB_TEST_SPREADSHEET_ID = 'test-case-sheet';
}
check('Existing API tokens are absent from security settings responses', () => {
  const e = environment(); prepareTestSpreadsheet(e);
  e.state.props.TASKHUB_API_TOKEN = 'previously-issued-api-token-with-enough-random-characters';
  const settings = e.c.getSecuritySettingsForWeb();
  assert.equal(settings.hasApiToken, true);
  assert.equal(Object.hasOwn(settings, 'apiToken'), false);
  assert.equal(Object.hasOwn(settings, 'tokenPreview'), false);
  assert.equal(JSON.stringify(settings).includes(e.state.props.TASKHUB_API_TOKEN), false);
});
check('A newly rotated API token is returned only from the one-time rotation response', () => {
  const e = environment(); prepareTestSpreadsheet(e);
  const settings = e.c.rotateApiTokenForWeb();
  assert.equal(settings.tokenReturnedOnce, true);
  assert.equal(settings.hasApiToken, true);
  assert.equal(settings.apiToken, e.state.props.TASKHUB_API_TOKEN);
  assert.equal(Object.hasOwn(settings, 'tokenPreview'), false);
  const nextSettings = e.c.getSecuritySettingsForWeb();
  assert.equal(Object.hasOwn(nextSettings, 'apiToken'), false);
  assert.equal(Object.hasOwn(nextSettings, 'tokenReturnedOnce'), false);
});
function body(title, action = 'が追加されました', course = '仮想情報演習', at = '09/13 08:00', schedule = '火曜5限') {
  return `曜日・時限：${schedule}\n授業名：${course}\n教員名：架空担当B、架空担当C\n更新内容：\n・課題(${title})${action}。(${at})`;
}
function row(id, title, mailBody, options = {}) {
  return [new Date(), id, options.source || 'inCampus', options.course || '仮想情報演習', title, options.due || '', options.dueStatus || '', title, '', options.received || new Date(), '', mailBody, options.status || '未確認', options.completedAt || '', '', ''];
}
function putMail(env, rows) {return env.add('inCampus通知', [env.headers, ...rows]);}
function logical(env, sheet) {return sheet.rows.slice(1).flatMap(row => Array.from(env.c.expandInCampusNotificationRow_(row)));}
function expectDate(date, year, month, day, hour, minute) {assert.ok(date instanceof Date); assert.deepEqual([date.getFullYear(), date.getMonth()+1, date.getDate(), date.getHours(), date.getMinutes()], [year, month, day, hour, minute]);}
check('All GAS scripts parse', () => {new vm.Script(source);});
check('Warm page loads skip storage bootstrap while weekly maintenance remains scheduled',()=>{
  const e=environment();
  const revisionKey=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY',e.c);
  const lastRunKey=vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY',e.c);
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props[revisionKey]=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION',e.c);
  e.state.props[lastRunKey]=new Date().toISOString();
  e.state.props[vm.runInContext('USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY',e.c)]=vm.runInContext('USER_TRIGGER_MAINTENANCE_REVISION',e.c);
  const result=e.c.ensureUserStorageForWeb_();
  assert.equal(result.ok,true);assert.equal(result.skipped,true);
  assert.equal(e.state.acquisitions,0,'a warm home request does not wait for the user lock');
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0,'a warm home request does not open the workbook for initialization');
  const weekly=e.c.ensureWeeklyUserStorageMaintenanceTrigger_();
  assert.equal(weekly.created,true);
  const trigger=e.state.triggers.find(item=>item.handler==='runWeeklyUserStorageMaintenance_');
  assert.deepEqual([trigger.weeks,trigger.weekday,trigger.hour],[1,'SUNDAY',4]);
});
check('A trigger revision update repairs its schedule on a warm request without reopening storage',()=>{
  const e=environment();
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props[vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY',e.c)]=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION',e.c);
  e.state.props[vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY',e.c)]=new Date().toISOString();
  const legacy={getHandlerFunction:()=> 'runDailyUserTriggerMaintenance_'};
  e.state.triggers.push(legacy);
  e.c.ensureNotificationStorage_=()=>{throw new Error('trigger configuration must not initialize workbook storage');};
  const result=e.c.ensureUserStorageForWeb_();
  assert.equal(result.ok,true);assert.equal(result.skipped,true);
  assert.equal(e.state.acquisitions,1,'the one-time schedule migration takes the user lock');
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0,'schedule migration does not open the workbook');
  assert.equal(e.state.triggers.includes(legacy),false);
  assert.equal(e.state.triggers.find(trigger=>trigger.handler==='run12HourlyUserTriggerMaintenance_').hours,12);
  assert.equal(e.state.props[vm.runInContext('USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY',e.c)],vm.runInContext('USER_TRIGGER_MAINTENANCE_REVISION',e.c));
});
check('Trigger health check migrates the old daily trigger to exactly one 12-hour background trigger',()=>{
  const e=environment();
  const legacy={getHandlerFunction:()=> 'runDailyUserTriggerMaintenance_'};
  e.state.triggers.push(legacy);
  const first=e.c.ensure12HourlyUserTriggerMaintenanceTrigger_();
  assert.equal(first.created,true);
  assert.equal(first.removedLegacyDailyTriggers,1);
  assert.equal(e.state.triggers.some(item=>item===legacy),false);
  const installed=e.state.triggers.find(item=>item.handler==='run12HourlyUserTriggerMaintenance_');
  assert.equal(installed.hours,12);
  assert.equal(e.c.ensure12HourlyUserTriggerMaintenanceTrigger_().created,false);
  assert.equal(e.state.triggers.filter(item=>item.handler==='run12HourlyUserTriggerMaintenance_').length,1);
});
check('12-hour trigger maintenance repairs sync triggers without opening the personal workbook',()=>{
  const e=environment();
  const originalAuto=e.c.ensureAutoFetchTrigger_, originalApi=e.c.ensureClassroomApiTrigger_;
  const originalWeekly=e.c.ensureWeeklyUserStorageMaintenanceTrigger_, originalStorage=e.c.ensureNotificationStorage_;
  e.c.ensureAutoFetchTrigger_=()=>({created:false});
  e.c.ensureClassroomApiTrigger_=()=>({created:false});
  e.c.ensureWeeklyUserStorageMaintenanceTrigger_=()=>({created:false});
  e.c.ensureNotificationStorage_=()=>{throw new Error('background trigger check must not touch workbook storage');};
  const result=e.c.run12HourlyUserTriggerMaintenance_();
  e.c.ensureAutoFetchTrigger_=originalAuto;e.c.ensureClassroomApiTrigger_=originalApi;
  e.c.ensureWeeklyUserStorageMaintenanceTrigger_=originalWeekly;e.c.ensureNotificationStorage_=originalStorage;
  assert.equal(result.ok,true);
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0);
  assert.ok(e.state.logs.some(message=>message.startsWith('TASKHUB_TRIGGER_MAINTENANCE_TIMING ')));
});
check('Home notification read reuses the one inCampus workbook snapshot for Gmail and extraction rows',()=>{
  const e=environment();
  const revisionKey=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY',e.c);
  const lastRunKey=vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY',e.c);
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props[revisionKey]=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION',e.c);
  e.state.props[lastRunKey]=new Date().toISOString();
  const unifiedHeaders=Array.from(vm.runInContext('INCAMPUS_UNIFIED_HEADERS',e.c));
  const mail=row('mail-snapshot','仮想課題',body('仮想課題'),{due:new Date(2099,9,25)}).concat(Array(unifiedHeaders.length-16).fill(''));
  mail[16]='gmail';
  const extract=Array(unifiedHeaders.length).fill('');
  extract[16]='extract';
  const extractValues=['inCampus','assignment','仮想課題','架空の詳細本文',new Date(2026,8,1),new Date(2099,9,25),'2026/09/01 09:00～2026/09/10 23:59','可','レポート','','https://ic.ss.senshu-u.jp/lms/course/report/virtual-snapshot',new Date(),new Date(),JSON.stringify({courseName:'仮想情報演習',weekdayPeriod:'火曜5限',updateText:'課題(仮想課題)が追加されました',updateAction:'add',assignmentKey:'virtual-snapshot'}),'未確認','','virtual-snapshot'];
  extractValues.forEach((value,index)=>{extract[17+index]=value;});
  const inCampus=e.add('inCampus通知',[unifiedHeaders,mail,extract]);
  e.add('補足通知',[e.headers]);
  e.add('Classroom通知',[e.headers]);
  const items=e.c.getNotificationsForWeb();
  assert.equal(inCampus.dataRangeCalls,1,'Gmail notification and extraction data share one getDataRange call');
  assert.ok(items.some(item=>String(item.messageId).startsWith('mail-snapshot:update:')));
  const timing=e.state.logs.find(message=>message.startsWith('TASKHUB_NOTIFICATION_READ_TIMING '));
  assert.ok(timing);
  assert.equal(JSON.parse(timing.slice('TASKHUB_NOTIFICATION_READ_TIMING '.length)).inCampusSnapshotReused,true);
});
check('Classroom submission sync uses paginated course-wide lookups and joins by coursework ID', () => {
  const e = environment();
  const calls = [];
  e.c.Classroom = {Courses: {CourseWork: {StudentSubmissions: {list(courseId, courseworkId, request) {
    calls.push({courseId, courseworkId, request});
    if (request.pageToken) return {studentSubmissions: [
      {courseWorkId: 'work-2', userId: 'student-current', state: 'RETURNED', late: true, assignedGrade: 8}
    ]};
    return {
      studentSubmissions: [{courseWorkId: 'work-1', userId: 'student-current', state: 'TURNED_IN'}],
      nextPageToken: 'submissions-next'
    };
  }}}}};

  const submissions = e.c.listClassroomApiExperimentStudentSubmissionsForCourse_('course-a');
  assert.equal(submissions.length, 2);
  assert.equal(calls.length, 2, 'the page token is followed for the complete response');
  assert.ok(calls.every(call => call.courseId === 'course-a' && call.courseworkId === '-'));
  assert.ok(calls.every(call => call.request.userId === 'me'));
  assert.ok(calls.every(call => call.request.fields.includes('courseWorkId')));
  assert.equal(calls[1].request.pageToken, 'submissions-next');

  const indexed = e.c.indexClassroomApiExperimentSubmissionsByCoursework_(submissions);
  assert.equal(indexed.missingCourseworkIdCount, 0);
  assert.equal(indexed.byCourseworkId.get('work-2')[0].state, 'RETURNED');
  assert.equal(e.c.selectClassroomApiExperimentCurrentStudentSubmission_(
    indexed.byCourseworkId.get('work-2'), 'student-current'
  ).assignedGrade, 8);
  assert.equal(e.c.indexClassroomApiExperimentSubmissionsByCoursework_([{state: 'NEW'}]).missingCourseworkIdCount, 1,
    'missing coursework IDs can be detected and cause the sync to fail closed');

  const syncSource = fs.readFileSync(path.join(gasSourceDir, 'ClassroomApiSync.gs'), 'utf8');
  const syncBody = syncSource.slice(syncSource.indexOf('function syncClassroomApiCourseworkToSpreadsheet_'), syncSource.indexOf('/** Save the Classroom API snapshot'));
  assert.match(syncBody, /listClassroomApiExperimentStudentSubmissionsForCourse_\(courseId\)/);
  assert.doesNotMatch(syncBody, /listClassroomApiExperimentStudentSubmissions_\(courseId, String\(item\.id/);
  return {pages: calls.length, courseworkIds: Array.from(indexed.byCourseworkId.keys())};
});
check('Real added + updated mail yields one assignment with nested parentheses/quotes', () => {
  const {c} = environment();
  const text = '履修者：SIM-000001\n\n曜日・時限：火曜5限\n授業名：仮想情報演習\n教員名：架空担当B、架空担当C\n更新内容：\n・課題(「仮想対話」課題)が追加されました。(07/03 08:00)\n・課題(「仮想対話」課題)が更新されました。(07/03 08:00)\n=====\n※※このメールは専修大学のin Campus発信専用です。返信はできません。※※';
  const records = c.extractInCampusMailRecords_('更新通知', text, new Date(2026, 6, 3)); assert.equal(records.length, 1); assert.equal(records[0].title, '「仮想対話」課題');
});
check('Multiple assignments and an announcement are independent while raw email remains intact', () => {
  const e = environment(), text = body('レポート1') + '\n・課題(レポート2)が追加されました。(09/13 08:00)\n・お知らせ(休講)が追加されました。(09/13 08:00)';
  const s = putMail(e, [row('mixed', 'レポート1', text)]), items = logical(e, s);
  assert.equal(items.length, 3); assert.equal(new Set(items.map(r => r[1])).size, 3);
  assert.equal(items.filter(e.c.isTaskRelatedRow_).length, 2); assert.equal(items.filter(e.c.isUniversityNoticeRow_).length, 1);
  assert.equal(items[0][5], ''); assert.equal(s.rows[1][11], text);
  e.c.updateNotificationStatus_(items[1][1], '完了', () => []);
  const next = logical(e, s); assert.equal(next[0][12], '未確認'); assert.equal(next[1][12], '完了'); assert.equal(s.rows[1][11], text);
});
check('Real multi-course assignment + submission mail stays separated', () => {
  const {c} = environment();
  const text = body('仮想心理課題（４）予習', 'が追加されました', '仮想心理演習', '07/05 11:27', '月曜2限') + '\n\n' + body('「仮想対話」課題', 'を提出しました', '仮想情報演習', '07/05 04:29');
  const records = c.extractInCampusMailRecords_('更新通知', text, new Date(2026, 6, 5));
  assert.deepEqual(Array.from(records, r => [r.type, r.title, r.courseName]), [['assignment', '仮想心理課題（４）予習', '仮想心理演習'], ['submission', '「仮想対話」課題', '仮想情報演習']]);
});
check('Existing single-row completion migrates only to its formerly displayed logical task', () => {
  const e = environment(), text = body('A') + '\n・課題(B)が追加されました。(09/13 08:00)';
  const s = putMail(e, [row('old', 'A', text, {status: '完了', completedAt: new Date()})]);
  const items = logical(e, s); assert.equal(items[0][12], '完了'); assert.equal(items[1][12], '未確認');
  e.c.updateNotificationStatus_('old', '未確認', () => []); assert.equal(logical(e, s)[0][12], '未確認');
});
check('Strict submission title: report1 never completes report10', () => {
  const e = environment(), s = putMail(e, [row('ten', 'レポート10', body('レポート10')), row('one', 'レポート1', body('レポート1'))]);
  e.c.completeMatchingInCampusMailRow_(s, {title: 'レポート1', courseName: '仮想情報演習', weekdayPeriod: '火曜5限', submittedAt: new Date(2026, 8, 13, 9)}, new Date());
  const items = logical(e, s); assert.equal(items[0][12], '未確認'); assert.equal(items[1][12], '完了');
});
check('Unknown course and mismatched schedule cannot auto-complete', () => {
  const e = environment(), s = putMail(e, [row('one', 'レポート1', body('レポート1'))]);
  for (const record of [{title: 'レポート1', courseName: ''}, {title: 'レポート1', courseName: '仮想情報演習', weekdayPeriod: '水曜5限'}]) assert.equal(e.c.completeMatchingInCampusMailRow_(s, record, new Date(2026, 8, 13, 9)), false);
  assert.equal(logical(e, s)[0][12], '未確認');
});
check('Submission event is idempotent and manual undo survives repeated ingestion', () => {
  const e = environment(), s = putMail(e, [row('one', 'レポート1', body('レポート1')), row('submitted', 'レポート1', body('レポート1', 'を提出しました', '仮想情報演習', '09/13 09:00'))]);
  assert.equal(e.c.applySavedInCampusSubmissionRecords_(s), 1); assert.equal(e.c.applySavedInCampusSubmissionRecords_(s), 0);
  e.c.updateNotificationStatus_(logical(e, s)[0][1], '未確認', () => []); assert.equal(e.c.applySavedInCampusSubmissionRecords_(s), 0); assert.equal(logical(e, s)[0][12], '未確認');
});
check('Duplicate email for same submission does not cancel manual undo', () => {
  const e = environment(), s = putMail(e, [row('one', 'A', body('A')), row('event1', 'A', body('A', 'を提出しました', '仮想情報演習', '09/13 09:00'))]);
  e.c.applySavedInCampusSubmissionRecords_(s); e.c.updateNotificationStatus_(logical(e,s)[0][1], '未確認', () => []);
  s.appendRow(row('event2', 'A', body('A', 'を提出しました', '仮想情報演習', '09/13 09:00')));
  assert.equal(e.c.applySavedInCampusSubmissionRecords_(s), 0); assert.equal(logical(e, s)[0][12], '未確認');
});
check('Old submission does not complete a later reused title', () => {
  const e = environment(), s = putMail(e, [row('future', 'A', body('A', 'が追加されました', '仮想情報演習', '09/13 10:00'))]);
  assert.equal(e.c.completeMatchingInCampusMailRow_(s, {title:'A', courseName:'仮想情報演習', submittedAt:new Date(2026,8,13,9)}, new Date()), false);
});
check('Submission binding does not migrate after an older assignment arrives', () => {
  const e = environment(), s = putMail(e, [row('A', 'A', body('A')), row('event', 'A', body('A', 'を提出しました', '仮想情報演習', '09/13 09:00'))]);
  e.c.applySavedInCampusSubmissionRecords_(s); s.appendRow(row('new-A', 'A', body('A', 'が追加されました', '仮想情報演習', '09/13 08:30')));
  assert.equal(e.c.applySavedInCampusSubmissionRecords_(s), 0); assert.equal(logical(e,s).find(r => r[1].startsWith('new-A:'))[12], '未確認');
});
check('Both duplicate Classroom task rows complete, returned mail is untouched', () => {
  const e = environment(), url = 'https://classroom.google.com/c/C/a/A/details';
  const rows = [e.headers, row('return','A','返却された課題\n'+url,{source:'Google Classroom'}), row('task1','A','新しい課題\n'+url,{source:'Google Classroom'}),row('task2','A','新しい課題\n'+url,{source:'Google Classroom'})];
  const s = e.add('補足通知', rows), result = e.c.completeClassroomAssignments_([{classroomUrl:url}]);
  assert.equal(result.matchedCount,1); assert.equal(s.rows[1][12],'未確認'); assert.equal(s.rows[2][12],'完了'); assert.equal(s.rows[3][12],'完了');
});
check('Both duplicate Classroom deadlines update, returned mail is untouched', () => {
  const e = environment(), url='https://classroom.google.com/c/C/a/A/details';
  const s=e.add('補足通知',[e.headers,...['返却された課題','新しい課題','新しい課題'].map((marker,i)=>row(String(i),'A',marker+'\n'+url,{source:'Google Classroom',due:'2026/09/15'}))]);
  e.c.updateClassroomDueTimes_([{classroomUrl:url,dueDate:'2026-09-20',dueTime:'23:59'}]);
  assert.equal(s.rows[1][5],'2026/09/15'); expectDate(s.rows[2][5],2026,9,20,23,59); expectDate(s.rows[3][5],2026,9,20,23,59);
});
check('Classroom non-task-only mail does not claim a match', () => {
  const e=environment(),url='https://classroom.google.com/c/C/a/A/details';e.add('補足通知',[e.headers,row('return','A','返却された課題\n'+url,{source:'Google Classroom'})]);
  assert.equal(e.c.completeClassroomAssignments_([{classroomUrl:url}]).matchedCount,0);
});
check('Midnight string and known Date deadline become prior day 23:59 across month/year/leap boundaries', () => {
  const {c}=environment();
  for(const [input,status,date] of [['2026/09/20 0:00','','2026-09-19'],[new Date(2026,8,20,0,0),'Classroomで時刻補正','2026-09-19'],['2026-01-01 00:00','','2025-12-31'],['2024年3月1日 00:00','','2024-02-29']]) {
    const out=c.normalizeDueInfoForWeb_(input,status);assert.equal(out.dueDateKey,date);assert.equal(out.dueTime,'23:59');
  }
});
check('Deadline minute remains valid through its last millisecond in server expiry checks', () => {
  const {c}=environment();
  const realDate=c.Date;
  const item={dueType:'detected',dueDateKey:'2026-10-10',dueTime:'23:59'};
  for(const [now,expired] of [['2026-10-10T23:59:59.999+09:00',false],['2026-10-11T00:00:00.000+09:00',true]]) {
    const fixed=Date.parse(now);
    c.Date=class extends realDate {static now(){return fixed;}};
    assert.equal(c.isExpiredNotificationForWeb_(item),expired,now);
  }
  for(const [now,expired] of [['2026-10-08T12:30:59.999+09:00',false],['2026-10-08T12:31:00.000+09:00',true]]) {
    const fixed=Date.parse(now);
    c.Date=class extends realDate {static now(){return fixed;}};
    assert.equal(c.isExpiredNotificationForWeb_({...item,dueDateKey:'2026-10-08',dueTime:'12:30'}),expired,now);
  }
});
check('Date-only values preserve their original day and unknown time', () => {
  const {c}=environment();for(const input of ['2026/09/20',new Date(2026,8,20)]) {const out=c.normalizeDueInfoForWeb_(input,'抽出成功');assert.equal(out.dueDateKey,'2026-09-20');assert.equal(out.dueTime,'');}
});
check('Latest valid dueAt/dueDate wins and missing date preserves stored date', () => {
  const {c}=environment();
  expectDate(c.buildClassroomDueDateValue_({dueAt:'2026-09-20T23:59:00+09:00',dueTime:'23:59'},'2026/09/15'),2026,9,20,23,59);
  expectDate(c.buildClassroomDueDateValue_({dueDate:'2026-09-20',dueTime:'19:30'},'2026/09/15'),2026,9,20,19,30);
  expectDate(c.buildClassroomDueDateValue_({dueDate:'',dueTime:'19:30'},'2026/09/15'),2026,9,15,19,30);
  expectDate(c.buildClassroomDueDateValue_({dueDate:'2026-02-30',dueTime:'19:30'},'2026/09/15'),2026,9,15,19,30);
  expectDate(c.buildClassroomDueDateValue_({dueAt:'2026-02-30T19:30:00+09:00',dueTime:'19:30'},'2026/09/15'),2026,9,15,19,30);
});
check('Repeated midnight time-only sync never subtracts another day', () => {
  const {c}=environment();let stored='2026/09/20';for(let i=0;i<4;i++){stored=c.buildClassroomDueDateValue_({dueTime:'00:00'},stored);expectDate(stored,2026,9,20,0,0);const visible=c.normalizeDueInfoForWeb_(stored,'Classroomで時刻補正');assert.equal(visible.dueDateKey,'2026-09-19');assert.equal(visible.dueTime,'23:59');}
});
check('Date-only dueAt does not invent midnight or subtract a day',()=>{
  const {c}=environment();const value=c.buildClassroomDueDateValue_({dueAt:'2026-09-20'},'2026/09/15');assert.equal(value,'2026/09/20');assert.equal(c.normalizeDueInfoForWeb_(value,'Classroomで日付補正').dueTime,'');
});
check('Separate announcement update IDs sharing course URL are stored independently',()=>{
  const e=environment(),url='https://ic.ss.senshu-u.ac.jp/lms/course/C';const a={source:'inCampus',type:'announcement',title:'休講',courseName:'仮想情報演習',pageUrl:url,assignmentKey:'update:1'};
  e.c.upsertInCampusAssignment_(a);e.c.upsertInCampusAssignment_({...a,title:'教室変更',assignmentKey:'update:2'});e.c.upsertInCampusAssignment_({...a,title:'休講（更新）'});
  const s=e.c.getOrCreateInCampusSheet_(),rows=s.getDataRange().getValues();assert.equal(s.getLastRow(),3);assert.equal(rows[1][2],'休講（更新）');assert.equal(rows[2][2],'教室変更');
});
check('Manual page extraction preserves course and update identity plus completed state',()=>{
  const {c}=environment(),url='https://ic.ss.senshu-u.ac.jp/lms/course/report/A';
  const original=c.buildAssignmentRow_({source:'inCampus',type:'assignment',courseName:'仮想情報演習',title:'A',body:'old',pageUrl:url,assignmentKey:'report:1',updateText:'課題(A)が追加',updateAt:'2026/09/13 08:00',status:'完了'});
  const saved=c.buildAssignmentRow_({source:'inCampus',type:'assignment',courseName:'',title:'A',body:'new',pageUrl:url,assignmentKey:url},original),raw=JSON.parse(saved[13]);
  assert.equal(raw.courseName,'仮想情報演習');assert.equal(raw.updateText,'課題(A)が追加');assert.equal(saved[16],'report:1');assert.equal(saved[3],'new');assert.equal(saved[14],'完了');
});
check('Extracted submission uses strict title and preserves manual undo on reprocessing',()=>{
  const e=environment(),url='https://ic.ss.senshu-u.ac.jp/lms/course/report/';const assignment=title=>({source:'inCampus',type:'assignment',title,courseName:'仮想情報演習',pageUrl:url+title,assignmentKey:title});
  e.c.upsertInCampusAssignment_(assignment('レポート10'));e.c.upsertInCampusAssignment_(assignment('レポート1'));
  const s=e.c.getOrCreateInCampusSheet_(),record={title:'レポート1',courseName:'仮想情報演習',submittedAt:'2026/09/13 09:00'};
  assert.equal(e.c.completeMatchingInCampusExtractedRow_(s,record),true);let rows=s.getDataRange().getValues();assert.equal(rows[1][14],'未確認');assert.equal(rows[2][14],'完了');
  e.c.updateInCampusExtractedStatus_('incampus:'+url+'レポート1','未確認');assert.equal(e.c.completeMatchingInCampusExtractedRow_(s,record),false);rows=s.getDataRange().getValues();assert.equal(rows[2][14],'未確認');
});
check('Two extracted report URLs with identical course/title remain ambiguous',()=>{
  const e=environment(),a={source:'inCampus',type:'assignment',title:'A',courseName:'仮想情報演習'};
  e.c.upsertInCampusAssignment_({...a,pageUrl:'https://ic.ss.senshu-u.ac.jp/lms/course/report/1'});e.c.upsertInCampusAssignment_({...a,pageUrl:'https://ic.ss.senshu-u.ac.jp/lms/course/report/2'});
  assert.equal(e.c.completeMatchingInCampusExtractedRow_(e.c.getOrCreateInCampusSheet_(),{title:'A',courseName:'仮想情報演習',submittedAt:'2026/09/13 09:00'}),false);
});
check('List and status response share one native lock and reads do not rewrite sheet',()=>{
  const e=environment(),s=putMail(e,[row('A','A',body('A'))]);e.c.getNotificationsForWeb();const writes=s.writes,acquires=e.state.acquisitions;
  e.c.getNotificationsForWeb();e.c.getCompletedNotificationsForWeb();e.c.getUniversityNoticesForWeb();assert.equal(s.writes,writes);
  assert.equal(e.state.acquisitions-acquires,3);const before=e.state.acquisitions;e.c.markNotificationDone(logical(e,s)[0][1]);assert.equal(e.state.acquisitions-before,1);assert.equal(e.state.held,false);
});
check('Concurrent status mutation cannot interleave a snapshot read and write',()=>{
  const e=environment(),s=putMail(e,[row('A','A',body('A')),row('B','B',body('B'))]), other=environment(e.state),id=logical(e,s)[0][1];
  s.onRead=()=>assert.throws(()=>other.c.updateNotificationStatus_(id,'未確認',()=>[]),/混み合/);
  e.c.updateNotificationStatus_(id,'完了',()=>[]);const items=logical(e,s);assert.equal(items[0][12],'完了');assert.equal(items[1][12],'未確認');assert.equal(e.state.held,false);
});
check('Lock is released when a nested operation throws',()=>{
  const e=environment();assert.throws(()=>e.c.runWithUserLock_('test',()=>e.c.runWithUserLock_('inner',()=>{throw new Error('boom');})),/boom/);assert.equal(e.state.acquisitions,1);assert.equal(e.state.releases,1);assert.equal(e.state.held,false);
});
check('Stale scheduled sync trigger is replaced once and then kept stable',()=>{
  const e=environment(),old={revision:'v43',getHandlerFunction:()=> 'saveClassroomMailsToSheet'};
  e.state.triggers.push(old);e.state.props.TASKHUB_AUTO_FETCH_TRIGGER_REVISION='old';
  const first=e.c.ensureAutoFetchTrigger_();assert.equal(first.created,true);assert.equal(first.replacedExisting,true);
  assert.equal(e.state.triggers.length,1);assert.notEqual(e.state.triggers[0],old);assert.equal(e.state.triggers[0].minutes,15);
  assert.equal(e.state.props.TASKHUB_AUTO_FETCH_TRIGGER_REVISION,'production-api-rollout-2026-10-05');
  const second=e.c.ensureAutoFetchTrigger_();assert.equal(second.created,false);assert.equal(e.state.triggers.length,1);
});
check('Logical states stay attached after normalizing/reordering and old row cleanup',()=>{
  const e=environment(),s=putMail(e,[row('older','A',body('A'),{received:new Date(Date.now()-1000)}),row('newer','B',body('B'))]);const id=logical(e,s)[0][1];e.c.updateNotificationStatus_(id,'完了',()=>[]);
  e.c.runWithUserLock_('normalize',()=>e.c.normalizeNotificationSheet_(s,{source:'inCampus'}));assert.equal(s.rows[1][1],'newer');assert.equal(logical(e,s).find(r=>r[1]===id)[12],'完了');
});
check('Actual Gmail ingestion keeps raw multi-update mail and makes logical tasks available',()=>{
  const e=environment(),text=body('A')+'\n・課題(B)が追加されました。(09/13 08:00)',message={getId:()=> 'mail',getFrom:()=> 'no-reply-incampus@isc.senshu-u.ac.jp',getDate:()=>new Date(),getSubject:()=> '更新通知',getPlainBody:()=>text};
  e.state.gmail=[{source:'inCampus',getMessages:()=>[message],getPermalink:()=> 'https://mail.google.com/mail/#thread'}];
  const first=e.c.saveClassroomMailsToSheet(),second=e.c.saveClassroomMailsToSheet();assert.equal(first.inCampusSavedCount,1);assert.equal(second.inCampusSavedCount,0);
  const s=e.state.sheets['inCampus通知'];assert.equal(s.getLastRow(),2);assert.equal(s.rows[1][11],text);assert.equal(e.c.getNotificationsForWeb().filter(i=>i.source==='inCampus').length,2);
});
check('A newly created workbook backfills 20 days once, then syncs after its received-time watermark',()=>{
  const e=environment(),received=new Date(Date.now()-3*60*60*1000),text=body('A'),message={getId:()=> 'watermark-mail',getFrom:()=> 'no-reply-incampus@isc.senshu-u.ac.jp',getDate:()=>received,getSubject:()=> '更新通知',getPlainBody:()=>text};
  e.state.gmail=[{source:'inCampus',getMessages:()=>[message],getPermalink:()=> 'https://mail.google.com/mail/#thread'}];
  e.c.saveClassroomMailsToSheet();
  const initialQuery=e.state.gmailQueries.find(entry=>entry.query.includes('incampus')).query;
  assert.match(initialQuery,/newer_than:20d/);assert.doesNotMatch(initialQuery,/newer_than:63d|after:/);
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,undefined,'successful initial scan clears its one-time flag');
  assert.ok(e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT,'successful scan stores a safe next lower bound');

  const baseline=new Date(Date.now()-60*60*1000);
  e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT=baseline.toISOString();
  const beforeWatermark={getId:()=> 'before-watermark',getFrom:()=> 'no-reply-incampus@isc.senshu-u.ac.jp',getDate:()=>new Date(baseline.getTime()-60*1000),getSubject:()=> '更新通知',getPlainBody:()=>body('old')};
  const afterWatermark={getId:()=> 'after-watermark',getFrom:()=> 'no-reply-incampus@isc.senshu-u.ac.jp',getDate:()=>new Date(baseline.getTime()+60*1000),getSubject:()=> '更新通知',getPlainBody:()=>body('new')};
  e.state.gmail=[{source:'inCampus',getMessages:()=>[message,beforeWatermark,afterWatermark],getPermalink:()=> 'https://mail.google.com/mail/#thread'}];
  e.c.saveClassroomMailsToSheet();
  const incrementalQuery=e.state.gmailQueries.filter(entry=>entry.query.includes('incampus'))[1].query;
  const baselineDay=`${baseline.getFullYear()}/${String(baseline.getMonth()+1).padStart(2,'0')}/${String(baseline.getDate()).padStart(2,'0')}`;
  assert.match(incrementalQuery,/newer_than:63d/);assert.ok(incrementalQuery.includes(`after:${baselineDay}`));
  assert.equal(e.state.sheets['inCampus通知'].getLastRow(),3,'same-day rows before the exact watermark are excluded and duplicates are deduplicated');
  assert.ok(e.state.sheets['inCampus通知'].rows.some(row=>row[1]==='after-watermark'));
  assert.ok(!e.state.sheets['inCampus通知'].rows.some(row=>row[1]==='before-watermark'));

  e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT=new Date(Date.now()-8*24*60*60*1000).toISOString();
  e.c.saveClassroomMailsToSheet();
  const laterQuery=e.state.gmailQueries.filter(entry=>entry.query.includes('incampus'))[2].query;
  assert.ok(laterQuery.includes(`after:${baselineDay}`),'elapsed time does not trigger a weekly full-window scan');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_LAST_FULL_RECONCILE_AT,undefined);
});
check('Failed initial Gmail scan keeps its 20-day initialization pending',()=>{
  const e=environment();e.state.onGmailSearch=()=>{throw new Error('mock Gmail search failed');};
  assert.throws(()=>e.c.saveClassroomMailsToSheet(),/mock Gmail search failed/);
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,'true');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT,undefined);
  assert.equal(e.state.held,false);
});
check('A first-run user gets a new workbook, imported Gmail rows, and a displayed task',()=>{
  const e=environment(),received=new Date(Date.now()-45*60*1000),text=body('初回利用者の仮想課題','が追加されました','仮想初回授業','10/05 08:00');
  const message={getId:()=> 'first-run-mail',getFrom:()=> 'no-reply-incampus@isc.senshu-u.ac.jp',getDate:()=>received,getSubject:()=> '更新通知',getPlainBody:()=>text};
  e.state.gmail=[{source:'inCampus',getMessages:()=>[message],getPermalink:()=> 'https://mail.google.com/mail/#thread/first-run-mail'}];

  assert.deepEqual(Array.from(e.c.getNotificationsForWeb()),[],'first page read creates an empty personal workbook');
  assert.equal(e.state.spreadsheetCreateCalls,1,'SpreadsheetApp.create runs once for a user with no workbook');
  const createdWorkbookId=e.state.props.TASKHUB_SPREADSHEET_ID;
  assert.ok(createdWorkbookId,'new workbook id is saved to user properties');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,'true','first-run backfill is marked pending');
  assert.equal(e.state.sheets['inCampus通知'].getLastRow(),1,'new notification sheet starts with its header');

  const result=e.c.syncAndGetNotificationsForWeb();
  assert.equal(e.state.spreadsheetCreateCalls,1,'sync reuses the workbook created during initial page read');
  assert.equal(e.state.props.TASKHUB_SPREADSHEET_ID,createdWorkbookId);
  assert.equal(result.inCampusSavedCount,1,'initial Gmail scan saves the synthetic message');
  assert.match(e.state.gmailQueries[0].query,/newer_than:20d/,'new workbook runs the one-time 20-day scan');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,undefined,'successful import clears the pending flag');
  const saved=e.state.sheets['inCampus通知'];
  assert.equal(saved.getLastRow(),2,'imported row is present beneath the header');
  assert.equal(saved.rows[1][1],'first-run-mail');
  assert.ok(result.items.some(item=>item.source==='inCampus'&&item.title==='初回利用者の仮想課題'),'the first-run task is returned to the web app for display');
});
check('An existing workbook with no valid received-time watermark skips rather than scanning old mail',()=>{
  const e=environment();e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  putMail(e,[row('invalid-watermark','A',body('A'),{received:'not-a-date'})]);
  const result=e.c.saveClassroomMailsToSheet();
  assert.equal(result.skipped,true);assert.match(result.reason,/既存の保存Excel/);assert.match(result.reason,/初回20日照合フラグもありません/);assert.equal(e.state.gmailSearches,0);
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,undefined);
});
check('An existing empty workbook does not become a first-run 20-day backfill',()=>{
  const e=environment();e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  const result=e.c.saveClassroomMailsToSheet();
  assert.equal(result.skipped,true);assert.match(result.reason,/有効な受信日時と前回同期日時がなく/);assert.equal(e.state.gmailSearches,0);
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,undefined);
});
check('Real deadline-word assignment title does not turn its update timestamp into a deadline',()=>{
  const {c}=environment(),title='前期未提出課題の期限後受付（再提出も可）';
  const expanded=c.expandInCampusNotificationRow_(row('deadline-title',title,body(title)));
  assert.equal(expanded[0][5],'');assert.match(expanded[0][6],/未検出/);
});
check('Classroom post/receipt timestamps and URL dates are not deadlines',()=>{
  const {c}=environment(), received=new Date(2026,9,8,10,30);
  const absent=c.extractDueDate_('テスト授業\n新しい課題\n投稿日：2026/10/08\n送信日時：2026/10/08 10:30\nhttps://classroom.google.com/c/2026/10/08/12345',received);
  assert.equal(absent.dueDate,'');assert.equal(absent.dueStatus,'期限未検出・要確認');
  const explicit=c.extractDueDate_('期限：2026/10/11 23:59\n投稿日：2026/10/08',received);
  assert.equal(explicit.dueDate,'2026/10/11 23:59');
});
check('Existing announcement read/save state follows only its legacy logical record',()=>{
  const e=environment(),text=body('A').replace('課題(A)','お知らせ(A)')+'\n・お知らせ(B)が追加されました。(09/13 08:00)';
  putMail(e,[row('legacy-notice','A',text)]);e.state.props['universityNotice:legacy-notice']=JSON.stringify({read:true,saved:true});
  const notices=e.c.getUniversityNoticesForWeb();assert.equal(notices.length,2);assert.equal(notices.find(n=>n.title==='A').saved,true);assert.equal(notices.find(n=>n.title==='B').saved,false);
});
check('User-deferred inline update behavior remains unchanged (#7)',()=>{
  const {c}=environment(),text='曜日・時限：火曜5限\n授業名：仮想情報演習\n教員名：教員\n更新内容：課題（レポート1）が追加されました';assert.equal(c.extractInCampusTitle_('更新通知',text),'更新通知');
});
check('Test mode is user-scoped, reads the fixed fixture, and keeps the saved sheet as its destination',()=>{
  const e=environment();e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';prepareTestSpreadsheet(e);
  assert.equal(e.c.getOrCreateSpreadsheet_().getId(),'test-sheet');
  const before=e.c.getSecuritySettingsForWeb();assert.equal(before.testCaseModeEnabled,false);assert.equal(before.testSpreadsheetReady,true);
  const enabled=e.c.setTestCaseModeForWeb(true);assert.equal(enabled.testCaseModeEnabled,true);
  assert.equal(e.c.getOrCreateSpreadsheet_().getId(),'test-sheet');
  assert.equal(e.c.getNotificationReadSheets_().inCampus.getName(),'テストinCampus');
  assert.equal(e.c.getNotificationReadSheets_().inCampus,e.state.testSheets['テストinCampus']);
  assert.equal(e.c.getNotificationReadSheets_()['Google Classroom'],e.state.testSheets['テストClassroom']);
  assert.equal(e.c.getInCampusReadSheet_(),e.state.testSheets['テスト抽出']);
  assert.equal(e.state.props.TASKHUB_SPREADSHEET_ID,'test-sheet');
  const disabled=e.c.setTestCaseModeForWeb(false);assert.equal(disabled.testCaseModeEnabled,false);assert.equal(e.c.getOrCreateSpreadsheet_().getId(),'test-sheet');
  assert.equal(e.c.getNotificationReadSheets_().inCampus,e.state.sheets['inCampus通知']);
  const liveExtractSheet=e.c.getInCampusReadSheet_();assert.equal(liveExtractSheet.__inCampusExtractAdapter,true);assert.equal(liveExtractSheet.getName(),'inCampus通知');
});
check('Virtual test clock presets are user-scoped, strict JST values and independent from test mode',()=>{
  const e=environment();prepareTestSpreadsheet(e);
  const initial=e.c.getTestCaseClockStateForWeb();assert.equal(initial.testCaseModeEnabled,false);assert.equal(initial.testCaseClockDateTime,'');
  assert.deepEqual(Array.from(initial.testCaseClockPresets,preset=>preset.id),['saturday','sunday','weekday','year-end','new-year','jst-utc-boundary','non-leap-year','month-end','leap-eve','leap-day']);
  const selected=e.c.setTestCaseClockForWeb('2026-12-31T23:58');
  assert.equal(selected.testCaseModeEnabled,false);assert.equal(selected.testCaseClockDateTime,'2026-12-31T23:58');
  assert.equal(e.state.props.TASKHUB_TEST_CASE_CLOCK,'2026-12-31T14:58:00.000Z');
  const enabled=e.c.setTestCaseModeForWeb(true);assert.equal(enabled.testCaseModeEnabled,true);assert.equal(enabled.testCaseClockDateTime,'2026-12-31T23:58');
  const disabled=e.c.setTestCaseModeForWeb(false);assert.equal(disabled.testCaseModeEnabled,false);assert.equal(disabled.testCaseClockDateTime,'2026-12-31T23:58');
  assert.throws(()=>e.c.setTestCaseClockForWeb('2027-02-29T09:00'),/日時が正しくありません/);
  assert.throws(()=>e.c.setTestCaseClockForWeb('2026-13-01T09:00'),/日時が正しくありません/);
  assert.throws(()=>e.c.setTestCaseClockForWeb('2026-12-31T24:00'),/日時が正しくありません/);
  e.c.setTestCaseClockForWeb('');assert.equal(e.state.props.TASKHUB_TEST_CASE_CLOCK,undefined);
});
check('Test mode pins synthetic receipt timestamps to the start of the session',()=>{
  const e=environment();prepareTestSpreadsheet(e);
  e.c.setTestCaseModeForWeb(true);
  const startedAt=e.state.props.TASKHUB_TEST_CASE_SESSION_STARTED_AT;
  assert.ok(startedAt);
  const row=Array(16).fill('');row[1]='SIM-SESSION-001';row[5]=new Date(2026,8,10);
  const mapped=e.c.mapTestCaseNotificationRowForRead_(row);
  assert.equal(mapped[0].toISOString(),startedAt);assert.equal(mapped[9].toISOString(),startedAt);
  e.c.setTestCaseModeForWeb(false);
  assert.equal(e.state.props.TASKHUB_TEST_CASE_SESSION_STARTED_AT,undefined);
});
check('Fixed spreadsheet dates shift in memory to the selected position and virtual clock',()=>{
  const e=environment();prepareTestSpreadsheet(e);e.state.props.TASKHUB_TEST_CASE_MODE='true';
  e.state.testSheets['テスト設定'].rows[2][1]='明日まで';
  // Simulate a Sheets serial value so the same conversion handles numeric cells too.
  e.state.testSheets['テスト設定'].rows[3][1]=46275;
  e.c.setTestCaseClockForWeb('2026-12-31T23:58');
  const referenceDate=new Date('2026-12-31T14:58:00.000Z');
  const readAt=new Date('2026-10-03T02:00:00.000Z');
  const context=e.c.getTestCaseDateContext_(e.testSs,referenceDate,readAt);
  assert.equal(context.deadlineDayOffset,113);
  const original=[new Date(2026,8,9),'SIM-CLASS-001','Google Classroom','仮想授業','仮想課題',46275,'Classroomで時刻補正','新しい課題: 仮想課題','架空担当A <fixture@example.invalid>',new Date(2026,8,9),'https://mail.example.invalid/thread/SIM-CLASS-001','仮想授業\n提出期限：2026/09/10 00:00','未確認','','',''];
  const sourceBefore=clone(original);
  const mapped=e.c.mapTestCaseNotificationRowForRead_(original,context);
  expectDate(mapped[5],2027,1,1,0,0);
  const normalized=e.c.normalizeDueInfoForWeb_(mapped[5],mapped[6]);
  assert.equal(normalized.dueDate,'2026/12/31 23:59');assert.equal(normalized.dueDateKey,'2026-12-31');assert.equal(normalized.dueTime,'23:59');assert.equal(normalized.dueType,'detected');
  assert.equal(mapped[0].getTime(),readAt.getTime());assert.equal(mapped[9].getTime(),readAt.getTime());
  assert.deepEqual(original,sourceBefore,'mapping must not mutate the read-only spreadsheet row');
  const extracted=['inCampus','assignment','仮想課題','架空の課題本文',new Date(2026,8,1),46275,'2026/09/01 09:00\n～\n2026/09/10 00:00','不可','個人','','https://portal.example.invalid/course/report/SIM-0001',new Date(2026,8,9),new Date(2026,8,9),'{}','未確認','','SIM-ASSIGN-0001'];
  const mappedExtract=e.c.mapTestCaseExtractRowForRead_(extracted,context);
  expectDate(mappedExtract[5],2027,1,1,0,0);
  assert.equal(e.c.rowToInCampusExtractedItem_(mappedExtract,e.c.getInCampusHeaderMap_(e.testSs.getSheetByName('テスト抽出'))).dueDate,'2026/12/31 23:59');
  assert.equal(mappedExtract[12].getTime(),readAt.getTime());
  assert.equal(extracted[5],46275,'the source serial value remains unchanged');
});
check('Server-side test expiry follows the selected year-end clock and leaves Jan 1 date-only work active',()=>{
  const e=environment();prepareTestSpreadsheet(e);e.state.props.TASKHUB_TEST_CASE_MODE='true';
  e.c.setTestCaseClockForWeb('2027-01-01T00:01');
  assert.equal(e.c.isExpiredNotificationForWeb_({dueType:'detected',dueDateKey:'2026-12-31',dueTime:'23:59'}),true);
  assert.equal(e.c.isExpiredNotificationForWeb_({dueType:'detected',dueDateKey:'2027-01-01',dueTime:''}),false);
  e.c.setTestCaseModeForWeb(false);
  assert.equal(e.c.isExpiredNotificationForWeb_({dueType:'detected',dueDateKey:'2026-12-31',dueTime:'23:59'}),false);
});
check('Test mode reads fixed virtual tabs, shifts deadlines after reading, and switches back without writing either source',()=>{
  const e=environment();e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';prepareTestSpreadsheet(e);e.c.setTestCaseClockForWeb('2099-10-01T00:00');
  e.state.testSheets['テスト設定'].rows[2][1]='明日まで';
  const personal=e.add('補足通知',[e.headers,row('personal-live','個人課題','架空担当A が新しい課題を投稿しました\n個人課題\n提出期限：2099/11/01 23:59',{source:'Google Classroom',course:'個人授業'})]);
  const fixtureRow=[new Date(2026,8,9),'SIM-CLASS-0001','Google Classroom','仮想授業','仮想課題',new Date(2026,8,10),'Classroomで時刻補正','新しい課題: 仮想課題','架空担当A <fixture@example.invalid>',new Date(2026,8,9),'https://mail.example.invalid/thread/SIM-CLASS-0001','仮想授業\n架空担当A が新しい課題を投稿しました\n仮想課題\n提出期限：2026/09/10 00:00\n詳細：https://courses.example.invalid/demo/SIM-CLASS-0001','未確認','','',''];
  const testClassroom=e.addTest('テストClassroom',[e.headers,fixtureRow]);
  const testInCampus=e.state.testSheets['テストinCampus'];
  const fakeCourse='仮想データ演習',fakeTitle='仮想期限付きレポート',fakeUrl='https://portal.example.invalid/course/report/SIM-0002';
  const fakeBody=`曜日・時限：火曜2限\n授業名：${fakeCourse}\n教員名：架空担当B\n更新内容：\n・課題（${fakeTitle}）が追加されました。（2026/09/10 08:00）`;
  const notificationRow=[new Date(2026,8,9),'SIM-INCA-0002','inCampus',fakeCourse,fakeTitle,new Date(2026,8,10),'期限検出','更新通知','架空担当B <fixture@example.invalid>',new Date(2026,8,9),'https://mail.example.invalid/thread/SIM-INCA-0002',fakeBody,'未確認','','',''];
  testInCampus.rows.push(notificationRow);
  const raw=JSON.stringify({courseName:fakeCourse,updateText:`・課題（${fakeTitle}）が追加されました。`,updateAction:'add',assignmentKey:'SIM-ASSIGN-0002'});
  const extractRow=['inCampus','assignment',fakeTitle,'架空の課題本文です。',new Date(2026,8,1),new Date(2026,8,10), '2026/09/01 09:00\n～\n2026/09/10 00:00','不可','個人','','https://portal.example.invalid/course/report/SIM-0002',new Date(2026,8,9),new Date(2026,8,9),raw,'未確認','','SIM-ASSIGN-0002'];
  const testExtract=e.state.testSheets['テスト抽出'];testExtract.rows.push(extractRow);
  e.state.props.TASKHUB_TEST_CASE_MODE='true';
  const testItems=e.c.getNotificationsForWeb();
  assert.deepEqual(Array.from(testItems,item=>item.messageId).sort(),['SIM-CLASS-0001','SIM-INCA-0002:update:'+e.c.inCampusStableKey_(e.c.inCampusRecordIdentity_({type:'assignment',courseName:fakeCourse,weekdayPeriod:'火曜2限',title:fakeTitle}))].sort());
  assert.equal(testItems.find(item=>item.messageId==='SIM-CLASS-0001').dueDate,'2099/10/01 23:59');
  assert.equal(testItems.find(item=>item.source==='inCampus').dueDate,'2099/10/01 23:59');
  assert.equal(testItems.some(item=>item.title==='個人課題'),false);
  assert.equal(testClassroom.writes,0);assert.equal(testInCampus.writes,0);assert.equal(testExtract.writes,0);
  const off=e.c.setTestCaseModeForWeb(false);assert.equal(off.testCaseModeEnabled,false);
  const savedItems=e.c.getNotificationsForWeb();assert.ok(savedItems.some(item=>item.title==='個人課題'));
  assert.equal(e.c.getOrCreateSpreadsheet_().getId(),'test-sheet');
  assert.equal(personal.writes,0);assert.equal(e.state.gmailSearches,0);
});
check('Fixed test workbook defaults safely and rejects an inaccessible or malformed sheet',()=>{
  const e=environment();const unavailable=e.c.getSecuritySettingsForWeb();assert.equal(unavailable.testSpreadsheetConfigured,true);assert.equal(unavailable.testSpreadsheetReady,false);
  assert.throws(()=>e.c.setTestCaseModeForWeb(true),/このGoogleアカウントで開けません/);assert.equal(e.state.props.TASKHUB_TEST_CASE_MODE,undefined);
  e.state.scriptProps.TASKHUB_TEST_SPREADSHEET_ID='test-case-sheet';e.addTest('テスト設定',[['設定',''],['開始',''],['位置','今日まで'],['基準日',new Date(2026,8,10)]]);e.addTest('テストClassroom',[['wrong']]);
  assert.throws(()=>e.c.setTestCaseModeForWeb(true),/見出しが一致/);assert.equal(e.state.props.TASKHUB_TEST_CASE_MODE,undefined);
});
check('Test mode keeps synthetic display data while Gmail sync writes only to the personal workbook',()=>{
  const e=environment();prepareTestSpreadsheet(e);e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';e.state.props.TASKHUB_TEST_CASE_MODE='true';
  e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT=new Date(Date.now()-60*1000).toISOString();
  const text=body('個人用メール課題'),message={getId:()=> 'personal-sync',getFrom:()=> 'no-reply-incampus@isc.senshu-u.ac.jp',getDate:()=>new Date(),getSubject:()=> '更新通知',getPlainBody:()=>text};
  e.state.gmail=[{source:'inCampus',getMessages:()=>[message],getPermalink:()=> 'mock://mail'}];
  const fixtureBefore=clone(e.state.testSheets['テストinCampus'].rows);
  const result=e.c.syncAndGetNotificationsForWeb();
  assert.equal(result.testCaseModeEnabled,true);assert.equal(result.savedCount,1);assert.equal(result.inCampusSavedCount,1);
  assert.equal(e.state.sheets['inCampus通知'].getLastRow(),2);assert.equal(e.state.sheets['inCampus通知'].rows[1][1],'personal-sync');
  assert.deepEqual(e.state.testSheets['テストinCampus'].rows,fixtureBefore);
  assert.equal(result.items.some(item=>item.messageId==='personal-sync'),false);
  assert.equal(e.c.getOrCreateSpreadsheet_().getId(),'test-sheet');assert.equal(e.state.gmailSearches,2);
});
check('Legacy rebuild endpoint uses incremental sync in test mode and extension POST writes to the personal workbook',()=>{
  const e=environment();prepareTestSpreadsheet(e);e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';e.state.props.TASKHUB_TEST_CASE_MODE='true';e.state.props.TASKHUB_API_TOKEN='x'.repeat(48);
  const fixtureBefore=clone(e.state.testSheets['テスト抽出'].rows);
  e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT=new Date(Date.now()-60*1000).toISOString();
  const rebuilt=e.c.rebuildAndGetNotificationsForWeb();assert.ok(Array.isArray(rebuilt));
  const response=e.c.doPost({postData:{contents:JSON.stringify({apiToken:'x'.repeat(48),action:'upsertInCampusAssignment',assignment:{
    source:'inCampus',type:'assignment',title:'仮想課題',courseName:'仮想講義',pageUrl:'https://ic.ss.senshu-u.ac.jp/lms/course/report/virtual-test'
  }})}});
  const payload=JSON.parse(response.value);assert.equal(payload.ok,true);
  const liveExtractSheet=e.c.getOrCreateInCampusSheet_(),extractRows=liveExtractSheet.getDataRange().getValues();
  assert.equal(liveExtractSheet.getLastRow(),2);
  assert.equal(extractRows[1][2],'仮想課題');
  assert.equal(extractRows[1][10],'https://ic.ss.senshu-u.ac.jp/lms/course/report/virtual-test');
  assert.deepEqual(e.state.testSheets['テスト抽出'].rows,fixtureBefore);
  assert.equal(e.state.testSheets['テスト抽出'].writes,0);
  assert.equal(e.state.gmailSearches,2,'the legacy endpoint uses the same narrow incremental Gmail search');
});
check('Test task reads use the fixture and completion state is per-user without sheet writes',()=>{
  const e=environment();e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';prepareTestSpreadsheet(e);
  const personal=e.add('inCampus通知',[e.headers,row('personal','個人課題',body('個人課題'))]);
  const fixture=e.addTest('テストinCampus',[e.headers,row('virtual-message','仮想課題',body('仮想課題'),{due:new Date(2026,8,10),dueStatus:'期限検出'})]);
  const testExtract=e.state.testSheets['テスト抽出'];
  e.state.props.TASKHUB_TEST_CASE_MODE='true';
  const items=e.c.getActiveNotificationItemsForWeb_();
  assert.equal(items.some(item=>item.title==='個人課題'),false);
  const virtual=items.find(item=>item.title==='仮想課題');assert.ok(virtual);
  const fixtureRowsBefore=clone(fixture.rows),fixtureWrites=fixture.writes,personalWrites=personal.writes;
  e.c.updateNotificationStatus_(virtual.messageId,'完了',()=>[]);
  assert.equal(e.c.getTestNotificationState_(virtual.messageId).status,'完了');
  const rows=e.c.getNotificationRowsFromSheets_(e.c.getNotificationReadSheets_());e.c.applyTestNotificationStatesToRows_(rows);
  assert.equal(rows.find(r=>r[1]===virtual.messageId)?.[12],'完了');
  assert.deepEqual(fixture.rows,fixtureRowsBefore);assert.equal(fixture.writes,fixtureWrites);
  assert.equal(testExtract.writes,0);assert.equal(personal.writes,personalWrites);
});
check('Test task completion overlays batch user properties once for large fixtures',()=>{
  const e=environment();prepareTestSpreadsheet(e);
  const modeKey=vm.runInContext('TEST_CASE_MODE_PROPERTY',e.c),prefix=vm.runInContext('TEST_NOTIFICATION_STATE_PROPERTY_PREFIX',e.c);
  e.state.props[modeKey]='true';
  const rows=Array.from({length:150},(_,i)=>['saved',`SIM-${i+1}`,'inCampus','仮想授業',`仮想課題${i+1}`,'','','','','','','','未確認','']);
  rows.forEach((row,i)=>{if(i%2===0)e.state.props[prefix+row[1]]=JSON.stringify({status:'完了',completedAt:'2026-10-03T00:00:00.000Z'});});
  e.state.userPropertyGetCalls=0;e.state.userPropertiesSnapshotCalls=0;
  const states=e.c.getTestNotificationStateMap_();e.c.applyTestNotificationStatesToRows_(rows,states);
  assert.equal(rows.filter(row=>row[12]==='完了').length,75);
  assert.equal(e.state.userPropertiesSnapshotCalls,1);
  assert.equal(e.state.userPropertyGetCalls,1,'mode is checked once while building the state snapshot, never once per task');
});
check('A test-mode list read opens and validates the fixture once and batches completion state',()=>{
  const e=environment();prepareTestSpreadsheet(e);
  const modeKey=vm.runInContext('TEST_CASE_MODE_PROPERTY',e.c);e.state.props[modeKey]='true';
  const prefix=vm.runInContext('TEST_NOTIFICATION_STATE_PROPERTY_PREFIX',e.c);
  const rows=Array.from({length:120},(_,i)=>[new Date(),`SIM-${i+1}`,'Google Classroom','仮想授業',`仮想課題${i+1}`,new Date(2099,9,25),'期限検出',`新しい課題: 仮想課題${i+1}`,'fixture@example.invalid',new Date(),'','新しい課題\n仮想課題','未確認','','','']);
  e.addTest('テストClassroom',[e.headers,...rows]);
  rows.slice(0,60).forEach(row=>{e.state.props[prefix+row[1]]=JSON.stringify({status:'完了',completedAt:'2026-10-03T00:00:00.000Z'});});
  const result=e.c.getNotificationsForWeb();
  assert.equal(result.length,60);
  assert.equal(e.state.spreadsheetOpenCalls['test-case-sheet'],1);
  assert.equal(e.state.userPropertiesSnapshotCalls,1);
  assert.ok(e.state.userPropertyGetCalls<=8,'mode is read a fixed number of times, independent of fixture row count');
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0,'test mode never opens the personal destination spreadsheet for reads');
});
check('Test-mode URL validation stays outside the notification-by-extract matching loop',()=>{
  const e=environment();e.state.userPropertyGetCalls=0;
  const extracted=Array.from({length:25},(_,i)=>({rawType:'assignment',rawUpdateText:`課題(仮想課題${i})が追加されました`,classroomUrl:`https://portal.example.invalid/course/report/SIM-${String(i+1).padStart(4,'0')}`,title:`仮想課題${i}`,courseName:`仮想授業${i}`,weekdayPeriod:'火曜5限',assignmentKey:`SIM-${i}`,receivedAtTime:i+1}));
  const notifications=Array.from({length:100},(_,i)=>{const index=Math.floor(i/4);return {source:'inCampus',title:`仮想課題${index}`,courseName:`仮想授業${index}`,weekdayPeriod:'火曜5限',receivedAtTime:i+1};});
  const merged=e.c.mergeNotificationAndInCampusExtractedItemsForWeb_(notifications,extracted,'assignment',true);
  assert.equal(merged.length,100);
  assert.ok(merged.every(item=>item.supplementKey&&item.classroomUrl.startsWith('https://portal.example.invalid/')));
  assert.equal(e.state.userPropertyGetCalls,0,'the 2,500 candidate checks reuse the request mode snapshot');
});
check('University notice read/save state is isolated from production while test mode is ON',()=>{
  const e=environment();e.state.props['universityNotice:notice-1']=JSON.stringify({read:true,saved:false});prepareTestSpreadsheet(e);e.state.props.TASKHUB_TEST_CASE_MODE='true';
  e.c.setUniversityNoticeState('notice-1',{read:false,saved:true});
  assert.deepEqual(JSON.parse(e.state.props['universityNotice:notice-1']),{read:true,saved:false});
  assert.deepEqual(JSON.parse(e.state.props['universityNotice:test:notice-1']),{read:false,saved:true});
});
console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,results},null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
