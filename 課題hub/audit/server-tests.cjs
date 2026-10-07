// Offline regression tests. Uses the real GAS functions and a rectangular sheet,
// persistent user properties, exclusive lock and Gmail mocks. No network access.
process.env.TZ = 'Asia/Tokyo';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const {matrixCases, boundaryCases} = require('./deadline-cases.cjs');
const base = path.resolve(__dirname, '..');
const gasSourceDir = path.join(base, 'taskhub-split/taskhub-split');
const gasFiles = fs.readdirSync(gasSourceDir).filter(name => name.endsWith('.gs'))
  .sort((a, b) => a === 'Code.gs' ? -1 : b === 'Code.gs' ? 1 : a.localeCompare(b));
const source = gasFiles.map(name => fs.readFileSync(path.join(gasSourceDir, name), 'utf8')).join('\n');
const results = [];
const clone = value => value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone) : value;
function mockBlob(data) {
  const bytes = Array.isArray(data) || Buffer.isBuffer(data) || ArrayBuffer.isView(data)
    ? Buffer.from(data)
    : Buffer.from(String(data), 'utf8');
  return {
    getBytes() {return Array.from(bytes);},
    getDataAsString() {return bytes.toString('utf8');}
  };
}
function check(name, fn) {try {fn(); results.push({name, passed: true});} catch (error) {results.push({name, passed: false, error: error.stack});}}
class Sheet {
  constructor(name, rows = []) {this.name = name; this.rows = clone(rows); this.writes = 0; this.dataRangeCalls = 0; this.rangeCalls = []; this.readCalls = []; this.maxRows = Math.max(100, rows.length); this.frozen = 0; this.onRead = null;}
  getName() {return this.name;}
  getSheetId() {return 1;}
  getLastRow() {let n = this.rows.length; while (n && this.rows[n - 1].every(v => v === '' || v == null)) n--; return n;}
  getLastColumn() {return Math.max(0, ...this.rows.map(r => r.length));}
  getDataRange() {this.dataRangeCalls++; return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));}
  getRange(r, c, h = 1, w = 1) {
    const sheet = this;
    sheet.rangeCalls.push({row: r, column: c, height: h, width: w});
    return {
      getValues() {sheet.readCalls.push({row:r,column:c,height:h,width:w});const output = Array.from({length: h}, (_, i) => Array.from({length: w}, (_, j) => clone(sheet.rows[r + i - 1]?.[c + j - 1] ?? ''))); if (sheet.onRead) {const f = sheet.onRead; sheet.onRead = null; f();} return output;},
      setValues(values) {assert.equal(values.length, h); for (const row of values) assert.equal(row.length, w); sheet.writes++; for (let i = 0; i < h; i++) {sheet.rows[r + i - 1] ||= []; for (let j = 0; j < w; j++) sheet.rows[r + i - 1][c + j - 1] = clone(values[i][j]);} return this;},
      setValue(value) {assert.equal(h, 1); assert.equal(w, 1); return this.setValues([[value]]);},
      clearContent() {return this.setValues(Array.from({length: h}, () => Array(w).fill('')));},
      setFontWeight() {return this;}
    };
  }
  appendRow(row) {this.rows.push(clone(row)); this.writes++;}
  insertRowsBefore(start, count) {this.rows.splice(start - 1, 0, ...Array.from({length: count}, () => [])); this.maxRows += count; this.writes++;}
  deleteRow(start) {this.rows.splice(start - 1, 1); this.writes++;}
  deleteRows(start, count) {this.rows.splice(start - 1, count); this.writes++;}
  insertRowsAfter(start, count) {this.maxRows += count;}
  setFrozenRows(n) {this.frozen = n;}
  getFrozenRows() {return this.frozen;}
  getMaxRows() {return this.maxRows;}
  autoResizeColumns() {throw new Error('Read must not auto-resize');}
}
function environment(shared) {
  const state = shared || {held: false, acquisitions: 0, releases: 0, flushes: 0, props: {}, scriptProps: {}, sheets: {}, testSheets: {}, triggers: [], gmail: [], gmailSearches: 0, gmailQueries: [], userPropertyGetCalls: 0, userPropertiesSnapshotCalls: 0, spreadsheetOpenCalls: {}, spreadsheetCreateCalls: 0, logs: [], cache: {}, cacheGetCalls: 0, cachePutCalls: 0};
  state.spreadsheetCreateCalls ||= 0;
  state.logs ||= [];
  state.cache ||= {};
  state.cacheGetCalls ||= 0;
  state.cachePutCalls ||= 0;
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
      newBlob(data) {return mockBlob(data);},
      gzip(blob) {return mockBlob(zlib.gzipSync(Buffer.from(blob.getDataAsString(), 'utf8')));},
      ungzip(blob) {return mockBlob(zlib.gunzipSync(Buffer.from(blob.getBytes())));},
      base64Encode(bytes) {return Buffer.from(bytes).toString('base64');},
      base64Decode(value) {return Array.from(Buffer.from(String(value), 'base64'));},
      getUuid: () => crypto.randomUUID(), formatDate(value, zone, pattern) {const d = new Date(value), p = x => String(x).padStart(2, '0'); const date = `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())}`; const isoDate = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; const full = `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; if (pattern === 'HH:mm') return `${p(d.getHours())}:${p(d.getMinutes())}`; if (pattern === "yyyy-MM-dd'T'HH:mm") return `${isoDate}T${p(d.getHours())}:${p(d.getMinutes())}`; if (pattern === 'yyyy-MM-dd') return isoDate; if (pattern === 'yyyy/MM/dd') return date; return pattern.endsWith(':ss') ? full : full.slice(0, 16);}},
    CacheService: {getUserCache() {return {
      get(key) {state.cacheGetCalls++; return state.cache[key] || null;},
      put(key, value, ttl) {state.cachePutCalls++; state.cache[key] = value; state.cacheTtl = ttl;},
      remove(key) {delete state.cache[key];}
    };}},
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
function markUserStorageWarm(env) {
  env.state.props.TASKHUB_SPREADSHEET_ID = 'test-sheet';
  const revisionKey = vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY', env.c);
  const lastRunKey = vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY', env.c);
  const triggerRevisionKey = vm.runInContext('USER_TRIGGER_MAINTENANCE_REVISION_PROPERTY', env.c);
  const displayRevisionKey = vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY', env.c);
  env.state.props[revisionKey] = vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION', env.c);
  env.state.props[lastRunKey] = new Date().toISOString();
  env.state.props[triggerRevisionKey] = vm.runInContext('USER_TRIGGER_MAINTENANCE_REVISION', env.c);
  env.state.props[displayRevisionKey] = vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION', env.c);
}
check('Warm web startup batches initialization and trigger checks into one read-only property snapshot',()=>{
  const e=environment();markUserStorageWarm(e);
  e.state.userPropertiesSnapshotCalls=0;e.state.userPropertyGetCalls=0;
  const acquisitions=e.state.acquisitions;
  const result=e.c.ensureUserStorageForWeb_();
  assert.equal(result.skipped,true);
  assert.equal(e.state.userPropertiesSnapshotCalls,1);
  assert.equal(e.state.userPropertyGetCalls,0);
  assert.equal(e.state.acquisitions,acquisitions,'a current workbook requires no startup lock');
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0,'a current workbook is not opened during startup');
});
check('Initial HTML preloads only the requested display payload and safely escapes user content',()=>{
  const e=environment(),calls=[];
  e.c.getTaskDisplayPayloadForWeb=status=>{calls.push(['task',status]);return {items:[{title:'課題'}]};};
  e.c.getUniversityNoticePayloadForWeb=forceRefresh=>{calls.push(['university',forceRefresh]);return {items:[{title:'お知らせ'}]};};
  const task=e.c.getInitialTaskHubPayloadForWeb_('assignment');
  assert.deepEqual(Array.from(task.payload.items,item=>item.title),['課題']);
  const notice=e.c.getInitialTaskHubPayloadForWeb_('university');
  assert.deepEqual(Array.from(notice.payload.items,item=>item.title),['お知らせ']);
  assert.deepEqual(calls,[['task','未完了'],['university',false]],'each entry page prepares only its own view');
  const original={view:'university',payload:{items:[{body:'</script><img src=x>&\u2028\u2029'}]}};
  const serialized=e.c.serializeTaskHubInitialPayload_(original);
  assert.equal(serialized.includes('</script>'),false,'email content cannot terminate the inert JSON script element');
  assert.equal(serialized.includes('<'),false);
  assert.equal(serialized.includes('&'),false);
  assert.deepEqual(JSON.parse(serialized),original,'escaping remains reversible for the browser JSON parser');
});
function expectDate(date, year, month, day, hour, minute) {assert.ok(date instanceof Date); assert.deepEqual([date.getFullYear(), date.getMonth()+1, date.getDate(), date.getHours(), date.getMinutes()], [year, month, day, hour, minute]);}
check('All GAS scripts parse', () => {new vm.Script(source);});
check('Sync-time task preparation assigns every weekday and Sunday-week boundary to its stored group', () => {
  const e = environment();
  for (const testCase of matrixCases) {
    const item = {messageId: testCase.id, status: '未確認', dueType: testCase.dueType,
      dueDateKey: testCase.dueDateKey, dueTime: testCase.dueTime};
    const prepared = e.c.prepareTaskDisplayItemsForSync_([item], '未完了', new Date(testCase.viewAt));
    assert.equal(prepared.length, 1, `${testCase.id} should remain active`);
    assert.equal(prepared[0].displayDueGroupKey, testCase.expectedGroup, testCase.id);
  }
});
check('Sync-time task preparation handles minute, midnight, year, leap-day, and invalid-date boundaries', () => {
  const e = environment();
  for (const testCase of boundaryCases) {
    const item = {messageId: testCase.id, status: '未確認', dueType: testCase.dueType,
      dueDateKey: testCase.dueDateKey, dueTime: testCase.dueTime};
    const prepared = e.c.prepareTaskDisplayItemsForSync_([item], '未完了', new Date(testCase.viewAt));
    if (testCase.expectedGroup === 'expired') {
      assert.equal(prepared.length, 0, testCase.id);
    } else {
      assert.equal(prepared.length, 1, testCase.id);
      assert.equal(prepared[0].displayDueGroupKey, testCase.expectedGroup, testCase.id);
    }
  }
});
check('Active task preparation sorts by due group and deadline; completed rows sort by completion time', () => {
  const e = environment();
  const now = new Date(2026, 9, 6, 10, 0);
  const active = [
    {messageId: 'later', status: '未確認', dueType: 'detected', dueDateKey: '2026-10-12', dueTime: '23:59', receivedAtTime: 30},
    {messageId: 'today-late', status: '未確認', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '23:59', receivedAtTime: 20},
    {messageId: 'today-early', status: '未確認', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '12:30', receivedAtTime: 10},
    {messageId: 'no-deadline', status: '未確認', dueType: 'none', dueDateKey: '', receivedAtTime: 40}
  ];
  const preparedActive = e.c.prepareTaskDisplayItemsForSync_(active, '未完了', now);
  assert.deepEqual(Array.from(preparedActive, item => item.messageId), ['today-early', 'today-late', 'later', 'no-deadline']);
  assert.deepEqual(Array.from(preparedActive, item => item.displayDueGroupIndex), [1, 1, 4, 5]);
  const completed = [
    {messageId: 'done-old', status: '完了', dueType: 'none', completedAtTime: 100},
    {messageId: 'done-new', status: '完了', dueType: 'none', completedAtTime: 200}
  ];
  const preparedCompleted = e.c.prepareTaskDisplayItemsForSync_(completed, '完了', now);
  assert.deepEqual(Array.from(preparedCompleted, item => item.messageId), ['done-new', 'done-old']);
  assert.ok(preparedCompleted.every(item => item.displayDueGroupKey === 'completed'));
});
check('Sync-time preparation stores group totals and course counts for direct rendering', () => {
  const e = environment();
  const now = new Date(2026, 9, 6, 10, 0);
  const prepared = e.c.prepareTaskDisplayItemsForSync_([
    {messageId: 'today-a', status: '未確認', courseName: '仮想A', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '12:00'},
    {messageId: 'today-b', status: '未確認', courseName: '仮想A', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '13:00'},
    {messageId: 'today-c', status: '未確認', courseName: '仮想B', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '14:00'},
    {messageId: 'tomorrow-a', status: '未確認', courseName: '仮想C', dueType: 'detected', dueDateKey: '2026-10-07', dueTime: '12:00'}
  ], '未完了', now);
  assert.deepEqual(Array.from(prepared, item => item.displayDueGroupCount), [3, 3, 3, 1]);
  assert.deepEqual(JSON.parse(prepared[0].displayDueGroupCourseCountsJson), [['仮想A', 2], ['仮想B', 1]]);
  assert.equal(prepared[1].displayDueGroupCourseCountsJson, '', 'only the first sorted row stores the group course summary');
  assert.deepEqual(JSON.parse(prepared[3].displayDueGroupCourseCountsJson), [['仮想C', 1]]);
});
check('Task display rows persist group metadata, and known old display headers migrate in place', () => {
  const e = environment();
  const oldHeaders = Array.from(vm.runInContext('LEGACY_TASK_DISPLAY_HEADERS', e.c));
  const oldSheet = e.add('課題表示データ', [oldHeaders, Array(oldHeaders.length).fill('legacy-row')]);
  e.c.getOrCreateDisplaySheetLocked_(e.ss, '課題表示データ', Array.from(vm.runInContext('TASK_DISPLAY_HEADERS', e.c)));
  assert.ok(oldSheet.rows[0].includes('期限表示グループ'));
  assert.ok(oldSheet.rows[0].includes('期限表示グループ件数'));
  assert.equal(oldSheet.rows[1][1], 'legacy-row', 'schema migration preserves existing row contents until rebuild replaces derived data');

  const previousHeaders = Array.from(vm.runInContext('PREVIOUS_TASK_DISPLAY_HEADERS', e.c));
  const previousSheet = e.add('完了課題表示データ', [previousHeaders, Array(previousHeaders.length).fill('previous-row')]);
  e.c.getOrCreateDisplaySheetLocked_(e.ss, '完了課題表示データ', Array.from(vm.runInContext('TASK_DISPLAY_HEADERS', e.c)));
  assert.equal(previousSheet.rows[0].at(-2), '期限表示グループ件数');
  assert.equal(previousSheet.rows[1][1], 'previous-row', 'the previously deployed display schema migrates in place');

  const prepared = e.c.prepareTaskDisplayItemsForSync_([
    {messageId: 'stored-today', status: '未確認', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '23:59'}
  ], '未完了', new Date(2026, 9, 6, 10));
  const fields = Array.from(vm.runInContext('TASK_DISPLAY_FIELDS', e.c));
  const rows = prepared.map(item => e.c.taskDisplayItemToRow_(item));
  const display = e.add('課題表示データ', [Array.from(vm.runInContext('TASK_DISPLAY_HEADERS', e.c)), ...rows]);
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY', e.c)] =
    vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION', e.c);
  const loaded = e.c.readMaterializedTaskItems_(e.ss, '未完了');
  assert.equal(loaded[0].displayDueGroupKey, 'today');
  assert.equal(loaded[0].displayDueGroupIndex, 1);
  assert.equal(loaded[0].displayDueGroupCount, 1);
  assert.deepEqual(JSON.parse(loaded[0].displayDueGroupCourseCountsJson), [['授業名未抽出', 1]]);
  assert.equal(display.rows[1].length, fields.length);
});
check('The previous university notice display schema migrates safely and unknown schemas stay protected',()=>{
  const e=environment();
  const previousHeaders=Array.from(vm.runInContext('PREVIOUS_UNIVERSITY_NOTICE_DISPLAY_HEADERS',e.c));
  const previousRow=Array(previousHeaders.length).fill('old-derived-value');
  previousRow[0]='legacy-notice-id';previousRow[2]='旧表示データ';
  const sheet=e.add('大学通知表示データ',[previousHeaders,previousRow]);
  e.add('inCampus通知',[e.headers]);e.add('補足通知',[e.headers]);e.add('Classroom通知',[e.headers]);
  const built=e.c.rebuildNotificationDisplayDataLocked_(e.ss);
  assert.equal(built.noticeCount,0);
  assert.deepEqual(Array.from(sheet.rows[0]),Array.from(vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_HEADERS',e.c)));
  assert.equal(sheet.getLastRow(),1,'old derived rows are replaced from source data during the rebuild');
  assert.equal(e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY',e.c)],vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION',e.c));

  const e2=environment();
  const unknown=e2.add('大学通知表示データ',[['unknown-schema'],['must-preserve']]);
  e2.add('inCampus通知',[e2.headers]);e2.add('補足通知',[e2.headers]);e2.add('Classroom通知',[e2.headers]);
  assert.throws(()=>e2.c.rebuildNotificationDisplayDataLocked_(e2.ss),/既存データ形式が異なる/);
  assert.deepEqual(unknown.rows,[['unknown-schema'],['must-preserve']],'unrecognized saved data is never erased by schema repair');
});
check('A transient prepared notice read failure leaves the workbook untouched and can be retried',()=>{
  const e=environment();e.c.rebuildNotificationDisplayDataLocked_(e.ss);markUserStorageWarm(e);
  const sheet=e.state.sheets['大学通知表示データ'];
  const writesBefore=Object.values(e.state.sheets).reduce((sum,current)=>sum+current.writes,0);
  sheet.onRead=()=>{throw new Error('temporary sheet read failure');};
  assert.throws(()=>e.c.getUniversityNoticePayloadForWeb(),/temporary sheet read failure/);
  const retried=e.c.getUniversityNoticePayloadForWeb();
  assert.deepEqual(Array.from(retried.items),[],'a later read recovers without needing a rebuild or data sync');
  assert.equal(Object.values(e.state.sheets).reduce((sum,current)=>sum+current.writes,0),writesBefore,
    'read retry never writes to the workbook');
});
check('A task status change refreshes saved active and completed group totals', () => {
  const e = environment();
  const now = new Date(2026, 9, 6, 10, 0);
  const preparedActive = e.c.prepareTaskDisplayItemsForSync_([
    {messageId: 'move-a', status: '未確認', courseName: '仮想A', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '12:00'},
    {messageId: 'stay-b', status: '未確認', courseName: '仮想B', dueType: 'detected', dueDateKey: '2026-10-06', dueTime: '13:00'}
  ], '未完了', now);
  const taskHeaders = Array.from(vm.runInContext('TASK_DISPLAY_HEADERS', e.c));
  const taskSheet = e.add('課題表示データ', [taskHeaders, ...preparedActive.map(e.c.taskDisplayItemToRow_)]);
  const completedSheet = e.add('完了課題表示データ', [taskHeaders]);
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY', e.c)] =
    vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION', e.c);
  assert.equal(e.c.updateMaterializedTaskStatusLocked_(e.ss, 'move-a', '完了', now), true);
  const countIndex = Array.from(vm.runInContext('TASK_DISPLAY_FIELDS', e.c)).indexOf('displayDueGroupCount');
  const courseCountsIndex = Array.from(vm.runInContext('TASK_DISPLAY_FIELDS', e.c)).indexOf('displayDueGroupCourseCountsJson');
  assert.equal(taskSheet.rows[1][countIndex], 1);
  assert.deepEqual(JSON.parse(taskSheet.rows[1][courseCountsIndex]), [['仮想B', 1]]);
  assert.equal(completedSheet.rows[1][countIndex], 1);
  assert.deepEqual(JSON.parse(completedSheet.rows[1][courseCountsIndex]), [['仮想A', 1]]);
});
check('Warm page loads skip storage bootstrap while weekly maintenance remains scheduled',()=>{
  const e=environment();
  const revisionKey=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY',e.c);
  const lastRunKey=vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY',e.c);
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props[revisionKey]=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION',e.c);
  e.state.props[lastRunKey]=new Date().toISOString();
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY',e.c)]=vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION',e.c);
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY',e.c)]=vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION',e.c);
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
check('A page read during a display-data rebuild never falls back to filtering raw sheets',()=>{
  const e=environment();markUserStorageWarm(e);
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_BUILDING_PROPERTY',e.c)]=String(Date.now());
  const result=e.c.ensureUserStorageForWeb_();
  assert.equal(result.skipped,true);assert.equal(result.displayDataBuilding,true);
  assert.equal(e.state.acquisitions,0,'a background projection refresh does not block list reads on the shared lock');
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0);
  assert.throws(()=>e.c.getNotificationsForWeb(),/表示データが未準備です/);
  assert.equal(Object.values(e.state.sheets).reduce((count,sheet)=>count+sheet.dataRangeCalls,0),0,
    'the read path does not fall back to raw sheets while sync is rebuilding the prepared view');
});
check('A trigger revision update repairs its schedule on a warm request without reopening storage',()=>{
  const e=environment();
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props[vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY',e.c)]=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION',e.c);
  e.state.props[vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY',e.c)]=new Date().toISOString();
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY',e.c)]=vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION',e.c);
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
check('Home notification read consumes the prepared task sheet without rereading inCampus source rows',()=>{
  const e=environment();
  const revisionKey=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION_PROPERTY',e.c);
  const lastRunKey=vm.runInContext('USER_STORAGE_INITIALIZATION_LAST_RUN_PROPERTY',e.c);
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props[revisionKey]=vm.runInContext('USER_STORAGE_INITIALIZATION_REVISION',e.c);
  e.state.props[lastRunKey]=new Date().toISOString();
  e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY',e.c)]=vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION',e.c);
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
  e.c.rebuildNotificationDisplayDataLocked_(e.ss);
  markUserStorageWarm(e);
  const rawReadCount=inCampus.dataRangeCalls;
  const items=e.c.getNotificationsForWeb();
  assert.equal(inCampus.dataRangeCalls,rawReadCount,'page rendering does not reread Gmail or extraction source rows');
  assert.ok(items.some(item=>String(item.messageId).startsWith('mail-snapshot:update:')));
  const timing=e.state.logs.find(message=>message.startsWith('TASKHUB_NOTIFICATION_READ_TIMING ')&&message.includes('personal-display-data'));
  assert.ok(timing);
  assert.equal(JSON.parse(timing.slice('TASKHUB_NOTIFICATION_READ_TIMING '.length)).rawNotificationSheetsRead,false);
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
check('Classroom API supplement rewrite preserves the parsed Gmail metadata column', () => {
  const e = environment();
  const rawMailRow = row(
    'classroom-mail-with-metadata',
    '仮想Classroom課題',
    '架空担当B posted a new assignment.\nhttps://classroom.example.invalid/course/task',
    {source: 'Google Classroom', received: new Date()}
  );
  const processedRow = Array.from(e.c.preprocessNotificationRowForStorage_(rawMailRow));
  const expectedWidth = e.c.getNotificationStorageWidth_('Google Classroom');
  assert.equal(expectedWidth, e.headers.length + 1);
  assert.equal(processedRow.length, expectedWidth);
  assert.ok(processedRow[expectedWidth - 1], 'the parsed Gmail fields are stored in the trailing metadata column');

  const sheet = e.add('補足通知', [
    [...e.headers, '解析済み通知データ'],
    processedRow
  ]);
  const supplementConfig = e.c.getNotificationStorageConfigForSource_('Google Classroom');
  const existingRows = sheet.getRange(2, 1, 1, expectedWidth).getValues();
  const normalizedRows = e.c.normalizeNotificationRowsForStorage_(existingRows, supplementConfig, new Date());
  assert.equal(normalizedRows[0].length, expectedWidth);

  e.c.replaceNotificationSheetRows_(sheet, normalizedRows);
  assert.equal(sheet.rows[1][expectedWidth - 1], processedRow[expectedWidth - 1],
    'the API sync round trip retains parsed data instead of dropping or recomputing it');
  e.c.replaceNotificationSheetRows_(sheet, []);
  assert.equal(sheet.rows[1][expectedWidth - 1], '', 'removing old mail also clears its trailing metadata cell');
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
check('Gmail ingestion stores parsed notice fields and strips only the inCampus closing footer', () => {
  const e = environment();
  const received = new Date(2026, 7, 31, 10, 15);
  const footer = '\n\u3000\u3000\u3000以上\n\n=====\n※※このメールは専修大学のin Campus発信専用です。返信はできません。※※';
  const text = body('仮想課題A') + '\n・お知らせ(休講案内)が追加されました。(08/31 09:00)' + footer;
  const input = row('preprocess-mail', '仮想課題A', text, {received});
  input[15] = JSON.stringify({existingSubmissionEvent: ['keep-me']});
  const saved = e.c.preprocessNotificationRowForStorage_(input);
  const ledger = JSON.parse(saved[15]);
  const processed = JSON.parse(saved[e.c.getNotificationProcessingColumn_('inCampus')]).__taskhubNoticeProcessing;
  assert.ok(!saved[11].includes('in Campus発信専用'));
  assert.ok(!saved[11].includes('以上\n'));
  assert.ok(saved[11].includes('仮想課題A'), 'the original message content remains available for reprocessing');
  assert.deepEqual(ledger.existingSubmissionEvent, ['keep-me'], 'existing submission mappings survive metadata storage');
  assert.deepEqual(Array.from(processed.records, record => [record.type, record.title, record.taskRelated, record.isUniversityNotice]), [
    ['assignment', '仮想課題A', true, false], ['announcement', '休講案内', false, true]
  ]);
  assert.equal(processed.records[1].expiresAt, new Date(2026, 8, 30, 10, 15).getTime(), 'inCampus expiry is fixed at one calendar month after receipt');
  assert.ok(!processed.records[1].displayBody.includes('in Campus発信専用'));
});
check('University notice reads use saved classification, expiry, title, and display body without reparsing', () => {
  const e = environment();
  const received = new Date(2026, 8, 10, 9);
  const original = row('cached-notice', '架空休講', '新しいお知らせ\n2026年10月20日に休講します。', {
    source: 'Google Classroom', received, course: '架空講義'
  });
  const cached = e.c.preprocessNotificationRowForStorage_(original);
  e.c.getClassroomNotificationType_ = () => { throw new Error('view reparsed Classroom category'); };
  e.c.getClassroomNoticeExpiry_ = () => { throw new Error('view reparsed notice expiry'); };
  e.c.cleanBodyForWeb_ = () => { throw new Error('view reformatted stored body'); };
  assert.equal(e.c.isUniversityNoticeRow_(cached), true);
  assert.equal(e.c.isUniversityNoticeVisible_(cached, new Date(2026, 9, 20, 23, 59)), true);
  assert.equal(e.c.isUniversityNoticeVisible_(cached, new Date(2026, 9, 21, 0, 0)), false);
  const notice = e.c.rowToUniversityNotice_(cached);
  assert.equal(notice.title, '架空休講');
  assert.equal(notice.body, '新しいお知らせ\n2026年10月20日に休講します。');
});
check('Cached Classroom notice survives storage-retention filtering without reparsing its body', () => {
  const e = environment();
  const received = new Date(2026, 5, 1, 9);
  const oldNotice = row('cached-old-notice', '架空行事', '新しいお知らせ\n2027年1月10日に開催します。', {
    source: 'Google Classroom', received, course: '架空講義'
  });
  const cached = e.c.preprocessNotificationRowForStorage_(oldNotice);
  e.c.getClassroomNotificationType_ = () => { throw new Error('retention filter reparsed cached category'); };
  e.c.getClassroomNoticeExpiry_ = () => { throw new Error('retention filter reparsed cached expiry'); };
  const retained = e.c.normalizeNotificationRowsForStorage_([cached], {source: 'Google Classroom'}, new Date(2026, 8, 1));
  assert.equal(retained.length, 1, 'the saved content date keeps this old received email within retention');
});
check('Cached multi-update inCampus notices expand without parsing the retained original body at view time', () => {
  const e = environment();
  const received = new Date(2026, 8, 10, 9);
  const raw = row('cached-incampus', '架空休講', body('架空課題').replace('課題(架空課題)', 'お知らせ(休講案内)'), {received});
  const cached = e.c.preprocessNotificationRowForStorage_(raw);
  e.c.extractInCampusMailRecords_ = () => { throw new Error('view split the inCampus email again'); };
  e.c.getInCampusMailKind_ = () => { throw new Error('view reclassified the inCampus email'); };
  e.c.extractInCampusTitle_ = () => { throw new Error('view extracted the inCampus title again'); };
  e.c.cleanBodyForWeb_ = () => { throw new Error('view reformatted the inCampus body'); };
  const children = e.c.expandInCampusNotificationRow_(cached);
  assert.equal(children.length, 1);
  assert.equal(e.c.isUniversityNoticeRow_(children[0]), true);
  const notice = e.c.rowToUniversityNotice_(children[0]);
  assert.equal(notice.title, '休講案内');
  assert.ok(notice.body.includes('お知らせ(休講案内)'));
});
check('The next normal sync backfills derived data while preserving logical and submission ledgers', () => {
  const e = environment();
  const text = body('架空課題') + '\n・お知らせ(架空休講)が追加されました。(09/13 08:00)';
  const legacy = row('legacy-preprocess', '架空課題', text);
  legacy[14] = JSON.stringify({legacyLogical: {status: '完了'}});
  legacy[15] = JSON.stringify({existingSubmissionEvent: ['keep-me']});
  const sheet = e.add('inCampus通知', [e.headers, legacy]);
  e.c.runWithUserLock_('backfill', () => e.c.normalizeNotificationSheet_(sheet, {source: 'inCampus'}));
  const saved = sheet.rows[1];
  const ledger = JSON.parse(saved[15]);
  assert.deepEqual(ledger.existingSubmissionEvent, ['keep-me']);
  assert.equal(JSON.parse(saved[14]).legacyLogical.status, '完了');
  const processed = JSON.parse(saved[e.c.getNotificationProcessingColumn_('inCampus')]).__taskhubNoticeProcessing;
  assert.equal(processed.version, vm.runInContext('NOTICE_PREPROCESSING_VERSION', e.c));
  assert.equal(processed.records.length, 2);
  assert.equal(saved[11], text, 'backfill retains the source body when no inCampus footer is present');
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
check('List reads skip the shared write lock while status mutation still uses it',()=>{
  const e=environment(),s=putMail(e,[row('A','A',body('A'))]);e.c.rebuildNotificationDisplayDataLocked_(e.ss);markUserStorageWarm(e);e.c.getNotificationsForWeb();const writes=s.writes,acquires=e.state.acquisitions;
  e.c.getNotificationsForWeb();e.c.getCompletedNotificationsForWeb();e.c.getUniversityNoticesForWeb();assert.equal(s.writes,writes);
  assert.equal(e.state.acquisitions-acquires,0);const before=e.state.acquisitions;e.c.markNotificationDone(logical(e,s)[0][1]);assert.equal(e.state.acquisitions-before,1);assert.equal(e.state.held,false);
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
  const s=e.state.sheets['inCampus通知'];assert.equal(s.getLastRow(),2);assert.equal(s.rows[1][11],text);assert.equal(s.rows[0][e.c.getNotificationProcessingColumn_('inCampus')],'解析済み通知データ');assert.ok(JSON.parse(s.rows[1][e.c.getNotificationProcessingColumn_('inCampus')]).__taskhubNoticeProcessing);assert.equal(e.c.getNotificationsForWeb().filter(i=>i.source==='inCampus').length,2);
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

  e.c.ensureUserStorageForWeb_();
  assert.deepEqual(Array.from(e.c.getNotificationsForWeb()),[],'the initial page setup prepares the empty display sheet before list reads');
  assert.deepEqual(Array.from(e.c.getUniversityNoticePayloadForWeb().items),[],
    'first university-notice page load reads the prepared empty sheet without requiring prior Gmail data');
  assert.equal(e.state.spreadsheetCreateCalls,1,'SpreadsheetApp.create runs once for a user with no workbook');
  const createdWorkbookId=e.state.props.TASKHUB_SPREADSHEET_ID;
  assert.ok(createdWorkbookId,'new workbook id is saved to user properties');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,'true','first-run backfill is marked pending');
  assert.equal(e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING,'true','the new personal workbook requests a one-time API + Gmail bootstrap');
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
check('A deleted personal workbook is replaced once and the new workbook is prepared for first sync',()=>{
  const e=environment();
  e.state.props.TASKHUB_SPREADSHEET_ID='deleted-workbook-id';
  e.state.props.SPREADSHEET_ID='deleted-legacy-id';
  e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT='2026-10-06T00:00:00.000Z';
  e.state.props.TASKHUB_CLASSROOM_API_LAST_SUCCESS_AT='2026-10-06T00:00:00.000Z';
  e.state.props.TASKHUB_CLASSROOM_API_STRUCTURED_SYNC_AT='2026-10-06T00:00:00.000Z';
  const initialized=e.c.ensureUserStorageForWeb_();
  assert.equal(initialized.ok,true);
  assert.equal(e.state.spreadsheetCreateCalls,1,'missing saved workbook is replaced once');
  assert.equal(e.state.props.TASKHUB_SPREADSHEET_ID,'test-sheet');
  assert.equal(e.state.props.SPREADSHEET_ID,undefined,'stale legacy destination is removed');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING,'true','new workbook is marked for initial Gmail history');
  assert.equal(e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING,'true','new workbook is marked for both-source bootstrap');
  assert.equal(e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT,undefined,'old Gmail watermark cannot skip the initial backfill');
  assert.equal(e.state.props.TASKHUB_CLASSROOM_API_LAST_SUCCESS_AT,undefined,'old Classroom watermark cannot skip the initial full sync');
  assert.equal(e.state.props.TASKHUB_CLASSROOM_API_STRUCTURED_SYNC_AT,undefined);
  assert.equal(e.state.sheets['課題表示データ'].getLastRow(),1,'empty workbook still receives prepared headers');
  e.c.ensureUserStorageForWeb_();
  assert.equal(e.state.spreadsheetCreateCalls,1,'retrying initialization reuses the replacement workbook');
});
check('Initial workbook bootstrap imports both sources once and does nothing for initialized workbooks',()=>{
  const e=environment();
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING='true';
  let syncCalls=0;
  e.c.syncPendingInitialPersonalData_=()=>{
    syncCalls++;
    e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING=undefined;
    e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT=new Date().toISOString();
    e.state.props.TASKHUB_CLASSROOM_API_LAST_SUCCESS_AT=new Date().toISOString();
    return {apiSuccess:true,apiResult:{courseCount:2,courseworkCount:5},gmailSuccess:true,gmailResult:{savedCount:3,classroomSavedCount:1,inCampusSavedCount:2}};
  };
  const first=e.c.bootstrapInitialPersonalDataForWeb();
  assert.equal(first.started,true);assert.equal(first.completed,true);assert.equal(first.apiCourseworkCount,5);assert.equal(first.savedCount,3);
  assert.equal(syncCalls,1);assert.equal(e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING,undefined);
  const second=e.c.bootstrapInitialPersonalDataForWeb();
  assert.equal(second.started,false);assert.equal(second.reason,'already-initialized');assert.equal(syncCalls,1);
});
check('Initial workbook bootstrap preserves its pending marker after a partial source failure',()=>{
  const e=environment();
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING='true';
  e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING='true';
  e.c.syncPendingInitialPersonalData_=()=>({apiSuccess:true,apiResult:{courseCount:1,courseworkCount:2},gmailSuccess:false,gmailError:'仮想Gmailエラー',gmailResult:{skipped:false}});
  const result=e.c.bootstrapInitialPersonalDataForWeb();
  assert.equal(result.started,true);assert.equal(result.completed,false);assert.equal(result.gmailSuccess,false);
  assert.equal(e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING,'true');
  assert.equal(e.state.props.TASKHUB_INITIAL_DATA_SYNC_IN_PROGRESS_AT,undefined);
});
check('Initial bootstrap retries only the source that did not finish previously',()=>{
  const e=environment();
  e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING='true';
  e.state.props.TASKHUB_CLASSROOM_API_LAST_SUCCESS_AT=new Date().toISOString();
  e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING='true';
  let apiCalls=0,gmailCalls=0;
  e.c.syncClassroomApiCourseworkToSpreadsheet_=()=>{apiCalls++;throw new Error('API must not rerun');};
  e.c.saveClassroomMailsToSheet=()=>{
    gmailCalls++;
    delete e.state.props.TASKHUB_NOTIFICATION_INITIAL_BACKFILL_PENDING;
    e.state.props.TASKHUB_NOTIFICATION_LAST_SUCCESSFUL_SYNC_AT=new Date().toISOString();
    return {savedCount:2,skipped:false};
  };
  const result=e.c.syncPendingInitialPersonalData_();
  assert.equal(apiCalls,0);assert.equal(gmailCalls,1);
  assert.equal(result.apiSuccess,true);assert.equal(result.gmailSuccess,true);assert.equal(result.initialSyncCompleted,true);
  assert.equal(e.state.props.TASKHUB_INITIAL_DATA_SYNC_PENDING,undefined);
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
  e.c.rebuildNotificationDisplayDataLocked_(e.ss);markUserStorageWarm(e);
  const notices=e.c.getUniversityNoticesForWeb();assert.equal(notices.length,2);assert.equal(notices.find(n=>n.title==='A').saved,true);assert.equal(notices.find(n=>n.title==='B').saved,false);
});
check('University notice reads skip Classroom assignment data and all list reads avoid the shared write lock',()=>{
  const e=environment();markUserStorageWarm(e);
  const text=body('連絡事項').replace('課題(連絡事項)','お知らせ(連絡事項)');
  const notice=row('read-only-notice','連絡事項',text);
  e.add('inCampus通知',[e.headers,notice]);
  e.add('Classroom通知',[e.headers]);e.add('補足通知',[e.headers]);
  e.c.rebuildNotificationDisplayDataLocked_(e.ss);
  markUserStorageWarm(e);
  let classroomApiReads=0,assignmentMerges=0;
  e.c.getClassroomApiNotificationRowsForWeb_=()=>{classroomApiReads++;return [];};
  e.c.mergeClassroomGmailAssignmentsWithApiRowsForWeb_=rows=>{assignmentMerges++;return rows;};
  const acquisitionsBefore=e.state.acquisitions;
  const writesBefore=Object.values(e.state.sheets).reduce((sum,sheet)=>sum+sheet.writes,0);
  const notices=e.c.getUniversityNoticePayloadForWeb().items;
  assert.equal(classroomApiReads,0,'university list does not open Classroom課題 / 提出状況');
  assert.equal(assignmentMerges,0,'university list skips the assignment merge pass');
  assert.ok(notices.some(item=>item.title==='連絡事項'));
  const timing=e.state.logs.find(message=>message.startsWith('TASKHUB_UNIVERSITY_NOTICE_LIST_READ '));
  assert.ok(timing);assert.equal(JSON.parse(timing.slice('TASKHUB_UNIVERSITY_NOTICE_LIST_READ '.length)).bodyColumnRead,false);
  e.c.getNotificationsForWeb();e.c.getCompletedNotificationsForWeb();
  assert.equal(e.state.acquisitions,acquisitionsBefore,'list endpoints do not hold the shared mutation lock');
  assert.equal(Object.values(e.state.sheets).reduce((sum,sheet)=>sum+sheet.writes,0),writesBefore,'opening lists does not write to any sheet');
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
  e.c.rebuildNotificationDisplayDataLocked_(e.ss);markUserStorageWarm(e);
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
  assert.equal(testClassroom.writes,0,'test Classroom workbook remains read-only');assert.equal(testInCampus.writes,0,'test inCampus workbook remains read-only');assert.equal(testExtract.writes,0,'test extraction workbook remains read-only');
  const off=e.c.setTestCaseModeForWeb(false);assert.equal(off.testCaseModeEnabled,false);
  const savedItems=e.c.getNotificationsForWeb();assert.ok(savedItems.some(item=>item.title==='個人課題'));
  assert.equal(e.c.getOrCreateSpreadsheet_().getId(),'test-sheet');
  assert.equal(personal.writes,0);assert.equal(e.state.gmailSearches,0);
});
check('University notice test mode reads the fixture and returns a compact projection without touching personal storage',()=>{
  const e=environment();prepareTestSpreadsheet(e);e.state.props.TASKHUB_SPREADSHEET_ID='test-sheet';
  e.c.setTestCaseClockForWeb('2026-09-10T09:00');
  e.c.setTestCaseModeForWeb(true);
  const fixture=e.state.testSheets['テストinCampus'];
  const noticeBody='履修者：SIM-000003\n曜日・時限：木曜2限\n授業名：仮想通知演習\n教員名：架空担当D\n更新内容：\n・お知らせ（年跨ぎ仮想連絡）が追加されました。(09/10 08:00)';
  fixture.rows.push(row('SIM-UNIVERSITY-CLOCK','年跨ぎ仮想連絡',noticeBody,{source:'inCampus',received:new Date(2026,8,10,9)}));
  fixture.rows[fixture.rows.length-1][7]='大学からのお知らせ';
  const sourceBefore=clone(fixture.rows);
  const payload=e.c.getUniversityNoticePayloadForWeb();
  const item=payload.items.find(notice=>notice.title==='年跨ぎ仮想連絡');
  assert.ok(item,'university test projection uses the fixed fixture');
  assert.equal(Object.hasOwn(item,'body'),false,'test list payload omits full bodies too');
  assert.ok(item.preview.includes('年跨ぎ仮想連絡'));
  assert.deepEqual(fixture.rows,sourceBefore,'test projection does not rewrite the shared test workbook');
  assert.equal(fixture.writes,0);
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,0,'test-mode list never opens the personal workbook');
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
  assert.equal(e.state.userPropertyGetCalls,0,'mode and completion states reuse one request snapshot without individual property lookups');
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
check('Sync-time display build materializes classified task and university notice records from raw inCampus mail',()=>{
  const e=environment();
  const unifiedHeaders=Array.from(vm.runInContext('INCAMPUS_UNIFIED_HEADERS',e.c));
  const unifiedWidth=unifiedHeaders.length+1;
  const bodyText='履修者：SIM-000001\n曜日・時限：火曜5限\n授業名：仮想情報演習\n教員名：架空担当B\n更新内容：\n・課題（仮想課題A）が追加されました。(10/06 08:00)\n・お知らせ（仮想告知A）が追加されました。(10/06 08:00)';
  const raw=row('materialize-mail','仮想通知',bodyText,{received:new Date()});
  raw[7]='課題通知と大学通知';raw[10]='https://mail.google.com/mail/u/0/#all/materialize-mail';
  const prepared=Array.from(e.c.preprocessNotificationRowForStorage_(raw));
  const unified=Array(unifiedWidth).fill('');prepared.forEach((value,index)=>{unified[index]=value;});
  unified[vm.runInContext('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN',e.c)]='gmail';
  const expiredRaw=row('old-materialize-mail','過去のお知らせ',
    '曜日・時限：月曜1限\n授業名：仮想過去授業\n更新内容：\n・お知らせ（過去のお知らせ）が追加されました。(08/01 08:00)',
    {received:new Date(2026,7,1,9)});
  expiredRaw[7]='大学からのお知らせ';
  const expiredPrepared=Array.from(e.c.preprocessNotificationRowForStorage_(expiredRaw));
  const expiredUnified=Array(unifiedWidth).fill('');expiredPrepared.forEach((value,index)=>{expiredUnified[index]=value;});
  expiredUnified[vm.runInContext('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN',e.c)]='gmail';
  e.add('inCampus通知',[unifiedHeaders,unified,expiredUnified]);
  e.add('補足通知',[e.headers]);
  e.add('Classroom通知',[e.headers]);
  e.state.props[vm.runInContext('TEST_CASE_MODE_PROPERTY',e.c)]='true';
  const result=e.c.rebuildNotificationDisplayDataLocked_(e.ss);
  assert.equal(result.taskCount,1);
  assert.equal(result.noticeCount,1);
  const taskSheet=e.state.sheets['課題表示データ'];
  const noticeSheet=e.state.sheets['大学通知表示データ'];
  assert.equal(taskSheet.getLastRow(),2);
  assert.equal(noticeSheet.getLastRow(),2);
  assert.equal(taskSheet.rows[1][vm.runInContext('TASK_DISPLAY_FIELDS',e.c).indexOf('title')],'仮想課題A');
  assert.equal(noticeSheet.rows[1][vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_FIELDS',e.c).indexOf('title')],'仮想告知A');
  assert.ok(!noticeSheet.rows.slice(1).some(displayRow=>displayRow[vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_FIELDS',e.c).indexOf('title')]==='過去のお知らせ'),
    'expired university notices are omitted while the sync builds the display sheet');
  assert.equal(e.state.props[vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY',e.c)],vm.runInContext('NOTIFICATION_DISPLAY_DATA_REVISION',e.c));
  assert.equal(e.state.testSheets['テストinCampus'],undefined,'materialization while test mode is ON still uses the personal workbook');
});
check('University notice list reads previews only, selection reads one body, and full-text search is deferred',()=>{
  const e=environment();
  const unifiedHeaders=Array.from(vm.runInContext('INCAMPUS_UNIFIED_HEADERS',e.c));
  const unifiedWidth=unifiedHeaders.length+1;
  const bodyText='履修者：SIM-000002\n曜日・時限：水曜3限\n授業名：仮想社会学\n教員名：架空担当C\n更新内容：\n・お知らせ（仮想休講案内）が追加されました。(10/06 08:00)\n'+('本文の長さを確認するための仮想説明。'.repeat(20))+'最後にだけある検索語「隠れた本文検索語」';
  const raw=row('SIM-NOTICE-CACHE-001','仮想休講案内',bodyText,{source:'inCampus',received:new Date(2026,9,6,9)});
  raw[7]='大学からのお知らせ';raw[10]='https://mail.google.com/mail/u/0/#all/SIM-NOTICE-CACHE-001';
  const prepared=Array.from(e.c.preprocessNotificationRowForStorage_(raw));
  const unified=Array(unifiedWidth).fill('');prepared.forEach((value,index)=>{unified[index]=value;});
  unified[vm.runInContext('INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN',e.c)]='gmail';
  e.add('inCampus通知',[unifiedHeaders,unified]);
  e.add('補足通知',[e.headers]);
  e.add('Classroom通知',[e.headers]);

  const built=e.c.rebuildNotificationDisplayDataLocked_(e.ss);
  assert.equal(built.noticeCount,1);
  assert.equal(e.state.cachePutCalls,0,'sync prepares the sheet but does not write the web cache');
  markUserStorageWarm(e);
  const noticeSheet=e.state.sheets['大学通知表示データ'];
  const bodyColumn=vm.runInContext("UNIVERSITY_NOTICE_DISPLAY_FIELDS.indexOf('body')+1",e.c);
  // Simulate a long prepared notice body: the list must omit its tail, while
  // selection and full-text search must still be able to find it.
  noticeSheet.rows[1][bodyColumn-1]=bodyText;
  e.state.userPropertiesSnapshotCalls=0;
  e.state.userPropertyGetCalls=0;
  const cacheReadsBeforeList=e.state.cacheGetCalls;
  const payload=e.c.getUniversityNoticePayloadForWeb();
  assert.equal(e.state.userPropertiesSnapshotCalls,1,'payload and display read share one property snapshot');
  assert.equal(e.state.userPropertyGetCalls,0,'display state uses the same property snapshot without per-item lookups');
  assert.deepEqual(Array.from(payload.items,item=>item.title),['仮想休講案内']);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.items[0],'body'),false,'the initial list payload omits full notice bodies');
  assert.ok(payload.items[0].preview.length<=180,'the initial list payload carries only a short body preview');
  assert.equal(noticeSheet.rows[1][vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_FIELDS',e.c).indexOf('preview')],payload.items[0].preview,
    'sync stores the preview so list opening never derives it from the body');
  assert.equal(e.state.cachePutCalls,0,'reading and returning the view does not write a full-body cache');
  assert.equal(e.state.cacheGetCalls,cacheReadsBeforeList,'list opening does not deserialize the full-body search cache');
  assert.equal(e.c.cacheUniversityNoticeItemsAfterWebDisplay(payload.items,payload.cacheToken),false,'a compact list cannot overwrite the full-body cache');
  assert.ok(noticeSheet.readCalls.every(call=>call.row===1||call.column+call.width-1<bodyColumn),
    'opening the list reads headers and preview columns only, never body cells: '+JSON.stringify(noticeSheet.readCalls));
  const detail=e.c.getUniversityNoticeBodyForWeb(payload.items[0].messageId);
  assert.equal(detail.found,true);
  assert.match(detail.body,/仮想休講案内/);
  assert.match(detail.body,/隠れた本文検索語/,'selected notice body includes the full prepared text');
  const detailReads=noticeSheet.readCalls.slice(-3);
  assert.ok(detailReads.some(call=>call.column===bodyColumn&&call.width===1&&call.height===1),
    'selecting one notice reads only its single body cell');
  assert.ok(detailReads.every(call=>call.row===1||call.column===1||call.column===bodyColumn),
    'selection does not load every notice body');
  assert.equal(e.state.cachePutCalls,0,'opening one notice does not cache every full body');
  assert.equal(e.state.cacheGetCalls,cacheReadsBeforeList,'selecting one notice reads its cell instead of decompressing all bodies');
  const cacheReadsBeforeSearch=e.state.cacheGetCalls;
  const search=e.c.searchUniversityNoticesForWeb('隠れた本文検索語');
  assert.deepEqual(Array.from(search.messageIds),[payload.items[0].messageId],'search still matches text found only in the full body');
  assert.ok(e.state.cacheGetCalls>cacheReadsBeforeSearch,'full-text cache is consulted when a search is requested');
  assert.equal(e.state.cachePutCalls,1,'full-body rows are cached only when a full-text search is requested');
  assert.equal(e.state.cacheTtl,21600,'cache lifetime covers the interval between periodic Gmail syncs');
  const readsAfterSearch=noticeSheet.rangeCalls.length;
  assert.deepEqual(Array.from(e.c.searchUniversityNoticesForWeb('隠れた本文検索語').messageIds),[payload.items[0].messageId]);
  assert.equal(noticeSheet.rangeCalls.length,readsAfterSearch,'subsequent body searches reuse the full-text cache');
  const stalePayload=e.c.getUniversityNoticePayloadForWeb();
  e.c.searchUniversityNoticesForWeb('隠れた本文検索語');
  e.c.rebuildNotificationDisplayDataLocked_(e.ss);
  assert.notEqual(stalePayload.cacheToken,e.c.getUniversityNoticePayloadForWeb().cacheToken,
    'a sync that advances the display generation invalidates the previous full-text cache key');
  markUserStorageWarm(e);
  const refreshed=e.c.getUniversityNoticePayloadForWeb();
  const readsBeforeCacheHit=noticeSheet.rangeCalls.length;
  e.c.searchUniversityNoticesForWeb('隠れた本文検索語');
  const readsAfterNewSearch=noticeSheet.rangeCalls.length;
  assert.ok(readsAfterNewSearch>readsBeforeCacheHit,'new display generation rebuilds full-text cache from current rows');
  const readsBeforeListHit=noticeSheet.rangeCalls.length;
  const rawSheet=e.state.sheets['inCampus通知'];
  rawSheet.onRead=()=>{throw new Error('a cache hit must not rebuild inCampus extracts');};
  const opened=e.state.spreadsheetOpenCalls['test-sheet']||0;
  const result=e.c.getUniversityNoticesForWeb();
  assert.deepEqual(Array.from(result,item=>item.title),['仮想休講案内']);
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet']||0,opened,'cache hit returns before opening the personal spreadsheet');
  assert.equal(noticeSheet.rangeCalls.length,readsBeforeListHit,'cache hit does not read the prepared sheet');
  assert.ok(e.state.logs.some(message=>message.includes('"mode":"cache-hit"')));
});
check('Prepared task views are status-specific, already filtered, and page reads only map saved values',()=>{
  const e=environment();markUserStorageWarm(e);
  const taskFields=Array.from(vm.runInContext('TASK_DISPLAY_FIELDS',e.c));
  const makeTask=(id,title,status,dueDateKey,dueTime,receivedAtTime)=>{
    const normalizedDateKey=e.c.normalizeNotificationDisplayDateKey_(dueDateKey);
    const normalizedTime=e.c.normalizeNotificationDisplayTime_(dueTime);
    const due=e.c.buildDeadlineDateTimeForWeb_(normalizedDateKey,normalizedTime);
    const item={messageId:id,source:'Google Classroom',title,status,dueType:'detected',dueDate:dueDateKey,dueDateKey,dueTime,dueStatus:'Classroom API',receivedAt:'2099/10/01 08:00',receivedAtTime,displayReceivedAtTime:receivedAtTime,completedAt:status==='完了'?'2099/10/01 09:00':'',completedAtTime:status==='完了'?receivedAtTime+1000:0,deadlineAtTime:due.getTime(),staleAtTime:''};
    return taskFields.map(field=>field==='savedAt'?new Date('2099-10-01T00:00:00Z'):field==='gmailMessageIds'?'[]':item[field]===undefined?'':item[field]);
  };
  const dateKeyDate=new Date(2099,9,25),timeValueDate=new Date(1899,11,30,23,59);
  const taskHeaders=Array.from(vm.runInContext('TASK_DISPLAY_HEADERS',e.c));
  const taskSheet=e.add('課題表示データ',[taskHeaders,
    makeTask('future-task','今後の課題','未確認',dateKeyDate,timeValueDate,10)]);
  const completedSheet=e.add('完了課題表示データ',[taskHeaders,
    makeTask('completed-task','完了課題','完了','2099-10-25','23:59',30)]);
  const noticeFields=Array.from(vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_FIELDS',e.c));
  const noticeHeaders=Array.from(vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_HEADERS',e.c));
  const makeNotice=(id,title,expiresAtTime,receivedAtTime)=>{
    const item={messageId:id,source:'inCampus',title,courseName:'仮想情報演習',receivedAt:'2099/10/01 08:00',receivedAtTime,gmailLink:'',body:'仮想本文',expiresAtTime,originalMessageIdForState:''};
    return noticeFields.map(field=>field==='supplementUpdatedAt'?new Date('2099-10-01T00:00:00Z'):item[field]===undefined?'':item[field]);
  };
  const noticeSheet=e.add('大学通知表示データ',[noticeHeaders,makeNotice('active-notice','表示対象',Date.now()+86400000,40)]);
  e.add('inCampus通知',[e.headers]).onRead=()=>{throw new Error('raw inCampus rows must not be read');};
  e.add('補足通知',[e.headers]).onRead=()=>{throw new Error('raw Classroom mail rows must not be read');};
  e.state.props['universityNotice:active-notice']=JSON.stringify({read:true,saved:true});
  e.c.isExpiredNotificationForWeb_=()=>{throw new Error('prepared view reads must not re-evaluate task deadlines');};
  e.c.isNotYetPublishedClassroomApiNotificationForWeb_=()=>{throw new Error('prepared view reads must not re-evaluate publish times');};
  e.c.isStaleUnknownDueNotificationForWeb_=()=>{throw new Error('prepared view reads must not re-evaluate retention status');};
  const active=e.c.getNotificationsForWeb(),completed=e.c.getCompletedNotificationsForWeb();
  const notices=e.c.getUniversityNoticePayloadForWeb().items;
  assert.deepEqual(active.map(item=>item.title),['今後の課題']);
  assert.deepEqual(Array.from(completed,item=>item.title),['完了課題']);
  assert.deepEqual(notices.map(item=>item.title),['表示対象']);
  const futureActive=active.find(item=>item.title==='今後の課題');
  assert.equal(typeof futureActive.savedAt,'string','sheet Dates are normalized before task results cross Apps Script RPC');
  assert.ok(Array.isArray(JSON.parse(JSON.stringify(active))),'prepared task results remain JSON-serializable arrays');
  assert.ok(Array.isArray(JSON.parse(JSON.stringify(notices))),'prepared notice results remain JSON-serializable arrays');
  assert.equal(notices[0].read,true);assert.equal(notices[0].saved,true);
  assert.equal(futureActive.dueDateKey,'2099-10-25','date-formatted keys stay canonical ISO dates after spreadsheet Date coercion');
  assert.equal(futureActive.dueTime,'23:59','time-formatted cells stay canonical HH:mm after spreadsheet Date coercion');
  assert.equal(taskSheet.dataRangeCalls,0);assert.equal(completedSheet.dataRangeCalls,0);assert.equal(noticeSheet.dataRangeCalls,0,
    'prepared views use schema-bounded ranges rather than reading each sheet data range');
  assert.ok(taskSheet.rangeCalls.some(call=>call.row===1&&call.height===taskSheet.getLastRow()&&call.width===vm.runInContext('TASK_DISPLAY_HEADERS.length',e.c)));
  const noticeBodyColumn=vm.runInContext("UNIVERSITY_NOTICE_DISPLAY_FIELDS.indexOf('body')+1",e.c);
  assert.ok(noticeSheet.readCalls.some(call=>call.row===1&&call.height===noticeSheet.getLastRow()&&call.width===noticeBodyColumn-1),
    'university notice list validates the used header and reads compact rows in one call');
  assert.ok(noticeSheet.readCalls.filter(call=>call.row>1).every(call=>call.column+call.width-1<noticeBodyColumn),
    'university notice list never reads body cells');
  assert.equal(e.state.sheets['inCampus通知'].dataRangeCalls,0);assert.equal(e.state.sheets['補足通知'].dataRangeCalls,0);
  assert.equal(e.state.spreadsheetOpenCalls['test-sheet'],3,'each view reads only its own prepared sheet');
  e.state.userPropertiesSnapshotCalls=0;
  const taskPayload=e.c.getTaskDisplayPayloadForWeb('active');
  assert.equal(e.state.userPropertiesSnapshotCalls,1,'task payload passes its property snapshot through the read path');
  assert.equal(e.state.cachePutCalls,0,'a display read does not synchronously write its task cache');
  assert.equal(e.c.cacheTaskDisplayItemsAfterWebDisplay(taskPayload.items,'active',taskPayload.cacheToken),true);
  const staleTaskPayload=e.c.getTaskDisplayPayloadForWeb('active');
  const taskStatusGenerationKey=vm.runInContext('TASK_DISPLAY_STATUS_GENERATION_PROPERTY',e.c);
  const statusGenerationBefore=e.state.props[taskStatusGenerationKey]||'0';
  assert.equal(e.c.updateMaterializedTaskStatusLocked_(e.ss,'future-task','完了',new Date(2099,9,1)),true);
  assert.notEqual(e.state.props[taskStatusGenerationKey]||'0',statusGenerationBefore,'a UI completion write invalidates the task cache generation');
  assert.equal(e.c.cacheTaskDisplayItemsAfterWebDisplay(staleTaskPayload.items,'active',staleTaskPayload.cacheToken),false,
    'a status change rejects a deferred cache write for the old list');
  assert.deepEqual(Array.from(e.c.getNotificationsForWeb(),item=>item.title),[]);
  assert.deepEqual(Array.from(e.c.getCompletedNotificationsForWeb(),item=>item.title),['今後の課題','完了課題']);
  assert.equal(taskSheet.getLastRow(),1,'completion removes the row from the active view');
  assert.equal(completedSheet.getLastRow(),3,'completion inserts the row into the completed view');
  const cachedNotices=e.c.getUniversityNoticePayloadForWeb().items;
  assert.deepEqual(Array.from(cachedNotices,item=>item.title),['表示対象']);
  assert.equal(noticeSheet.readCalls.filter(call=>call.row>1&&call.column+call.width-1>=noticeBodyColumn).length,0,
    'ordinary list rereads never transfer full bodies');
  e.c.setUniversityNoticeState('active-notice',{read:false,saved:false});
  const refreshedNotices=e.c.getUniversityNoticePayloadForWeb().items;
  assert.equal(noticeSheet.readCalls.filter(call=>call.row===1&&call.column+call.width-1<noticeBodyColumn).length >= 3,true,
    'changing read/save state is reflected from the prepared notice sheet');
  assert.equal(refreshedNotices[0].read,false);assert.equal(refreshedNotices[0].saved,false);
});
check('Sync-time task preparation excludes expired, stale, future-published and wrong-status rows before persistence',()=>{
  const e=environment(),now=new Date(2026,9,7,12,0),nowMs=now.getTime();
  const make=(messageId,status,dueDateKey,dueType,receivedAtTime)=>e.c.addStoredTaskDateChecks_({
    messageId,status,dueDateKey,dueTime:'23:59',dueDate:dueDateKey,dueType,
    receivedAtTime,displayReceivedAtTime:receivedAtTime,completedAtTime:status==='完了'?receivedAtTime+100:0
  });
  const rows=[
    make('fresh-task','未確認','2026-10-08','detected',nowMs-1000),
    make('expired-task','未確認','2026-10-06','detected',nowMs-2000),
    make('stale-task','未確認','','unknown',nowMs-8*24*60*60*1000),
    make('classroom-api:course:future','未確認','2026-10-10','detected',nowMs+60*1000),
    make('completed-task','完了','2026-10-08','detected',nowMs-3000),
    make('completed-expired-task','完了','2026-10-06','detected',nowMs-4000)
  ];
  const active=e.c.prepareTaskDisplayItemsForSync_(rows,'未完了',now);
  const completed=e.c.prepareTaskDisplayItemsForSync_(rows,'完了',now);
  assert.deepEqual(Array.from(active,row=>row.messageId),['fresh-task']);
  assert.deepEqual(Array.from(completed,row=>row.messageId),['completed-task']);
});
check('University display builder sorts once and its reader preserves the saved order',()=>{
  const e=environment();
  const built=e.c.buildUniversityNoticeDisplayItems_([
    {messageId:'older',source:'Google Classroom',title:'古い',receivedAtTime:10,expiresAtTime:null},
    {messageId:'newer',source:'Google Classroom',title:'新しい',receivedAtTime:20,expiresAtTime:null}
  ],[],false);
  assert.deepEqual(Array.from(built,item=>item.messageId),['newer','older']);
  const noticeFields=Array.from(vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_FIELDS',e.c));
  const noticeHeaders=Array.from(vm.runInContext('UNIVERSITY_NOTICE_DISPLAY_HEADERS',e.c));
  const makeRow=item=>noticeFields.map(field=>item[field]===undefined||item[field]===null?'':item[field]);
  const e2=environment();markUserStorageWarm(e2);
  const sheet=e2.add('大学通知表示データ',[noticeHeaders,...built.map(makeRow)]);
  const read=e2.c.getMaterializedUniversityNoticesForWeb_(e2.ss,new Date(),{});
  assert.deepEqual(Array.from(read,item=>item.messageId),['newer','older']);
  assert.equal(sheet.dataRangeCalls,0);
  assert.ok(sheet.rangeCalls.some(call=>call.width===noticeHeaders.length&&call.height===sheet.getLastRow()));
});
check('Test university notices are materialized from immutable fixtures with production preprocessing at the selected virtual time',()=>{
  const e=environment();prepareTestSpreadsheet(e);
  const source=row('SIM-NOTICE-001','架空の休講案内','大学からのお知らせです。',{source:'inCampus',received:new Date(2026,8,10,9)});
  const fixture=e.addTest('テストinCampus',[e.headers,source]);
  e.c.setTestCaseModeForWeb(true);
  e.state.props.TASKHUB_TEST_CASE_SESSION_STARTED_AT='2026-10-01T00:00:00.000Z';
  e.c.setTestCaseClockForWeb('2026-10-15T12:00');
  const first=e.c.getUniversityNoticesForWeb(true);
  assert.equal(first.length,1);
  assert.equal(first[0].title,'架空の休講案内');
  assert.ok(first[0].expiresAtTime > new Date('2026-10-15T03:00:00.000Z').getTime());
  assert.ok(e.state.logs.some(message=>message.includes('"mode":"test-fixture-materialized"')));
  assert.equal(fixture.writes,0,'test rows and their original dates are never rewritten');
  assert.equal(e.state.gmailSearches,0,'test materialization never starts Gmail synchronization');
  e.c.setTestCaseClockForWeb('2026-11-01T12:00');
  const afterExpiry=e.c.getUniversityNoticesForWeb();
  assert.equal(afterExpiry.length,0,'changing the selected virtual date rebuilds the projection and applies the same expiry boundary');
  assert.equal(fixture.rows[1][9].getTime(),new Date(2026,8,10,9).getTime(),'virtual dates are applied only to in-memory copies');
});
console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,results},null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
