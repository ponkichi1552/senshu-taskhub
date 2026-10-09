// Offline regression tests for the real browser scripts. No Google connection.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const sourceDir = path.resolve(__dirname, '../taskhub-split/taskhub-split');

function element() {
  const classes = new Set();
  const appendChild = (parent, child) => {
    if (child && child.isDocumentFragment) parent.children.push(...child.children);
    else parent.children.push(child);
  };
  const node = {
    children: [], style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    classList: {
      add(...names) {names.forEach(name => classes.add(name));},
      remove(...names) {names.forEach(name => classes.delete(name));},
      contains(name) {return classes.has(name);},
      toggle(name, value) {value = value === undefined ? !classes.has(name) : value;
        if (value) classes.add(name); else classes.delete(name); return value;}
    },
    setAttribute(name, value) {this[name] = value;},
    append(...children) {children.forEach(child => appendChild(this, child));},
    appendChild(child) {appendChild(this, child);},
    replaceChildren(...children) {this.children = []; children.forEach(child => appendChild(this, child));},
    addEventListener() {}
  };
  let innerHTML = '';
  Object.defineProperty(node, 'innerHTML', {
    get() {return innerHTML;},
    set(value) {innerHTML = String(value); this.children = [];}
  });
  return node;
}

function fixture(fixedNow, {holdBoot = false, initialRoute = 'home', initialSyncPending = false, initialPayload = null} = {}) {
  const calls = [], alerts = [], nodes = new Map(), timers = [], animationFrames = [];
  let reloadCount = 0;
  const body = {dataset: {taskhubInitialSync: initialSyncPending ? 'true' : 'false', taskhubInitialView: initialRoute}};
  const initialPayloadNode = element();
  initialPayloadNode.textContent = initialPayload ? JSON.stringify(initialPayload) : '';
  nodes.set('taskhub-initial-payload', initialPayloadNode);
  const document = {
    body,
    getElementById(id) {if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);},
    querySelectorAll() {return [];}, createElement: element,
    createDocumentFragment() {const fragment = element(); fragment.isDocumentFragment = true; return fragment;}
  };
  const script = {};
  Object.defineProperty(script, 'run', {get() {
    const call = {settled: false};
    const runner = new Proxy({}, {get(_, name) {
      if (name === 'withSuccessHandler') return handler => {call.success = handler; return runner;};
      if (name === 'withFailureHandler') return handler => {call.failure = handler; return runner;};
      return (...args) => {call.method = name; call.args = args; calls.push(call);};
    }});
    return runner;
  }});
  const ClockDate = fixedNow == null ? Date : class extends Date {
    constructor(...args) {super(...(args.length ? args : [fixedNow]));}
    static now() {return fixedNow;}
  };
  const location = {href: 'https://script.google.com/test', reload() {reloadCount++;}};
  const context = vm.createContext({Date: ClockDate, URL, document,
    window: {location},
    localStorage: {getItem: () => 'true', setItem() {}},
    google: {script}, console: {error() {}, info() {}}, alert: message => alerts.push(message),
    requestAnimationFrame(callback) {animationFrames.push(callback); return animationFrames.length;},
    setInterval() {}, setTimeout(callback) {timers.push(callback); return timers.length;}, clearTimeout() {}
  });
  const scriptFiles = [
    'UniversityScripts.html', 'Scripts.html', 'ScriptsHome.html', 'ScriptsSettings.html',
    'ScriptsSync.html', 'ScriptsCourseFilter.html', 'ScriptsRendering.html',
    'ScriptsActions.html', 'ScriptsBoot.html'
  ];
  for (const file of scriptFiles) {
    vm.runInContext(fs.readFileSync(path.join(sourceDir, file), 'utf8').replace(/<\/?script>/g, ''), context, {filename: file});
  }
  if (!holdBoot) {
    const boot = calls.find(call => call.method === 'getTaskDisplayPayloadForWeb' || call.method === 'getUniversityNoticePayloadForWeb');
    if (boot) {boot.settled = true; boot.success([]);}
  }
  function take(method, id) {
    const call = calls.filter(call => !call.settled && call.method === method && (id === undefined || call.args[0] === id)).at(-1);
    assert.ok(call, `Expected pending ${method} ${id || ''}`);
    return call;
  }
  function reply(call, data = []) {assert.ok(!call.settled); call.settled = true; call.success(data);}
  function fail(call) {assert.ok(!call.settled); call.settled = true; call.failure(new Error('offline'));}
  function read(code) {return JSON.parse(JSON.stringify(vm.runInContext(code, context)));}
  function ids(name) {return read(`${name}.map(item => item.messageId).sort()`);}
  function seed(active, completed = []) {
    context.setNotificationData(active, 'active'); context.setNotificationData(completed, 'completed');
    context.showAssignmentView('active');
  }
  function pending(method, id) {return calls.filter(call => !call.settled && call.method === method && (id === undefined || call.args[0] === id));}
  return {c: context, calls, alerts, document, take, reply, fail, read, ids, seed, pending,
    flushAnimationFrame() {const callbacks = animationFrames.splice(0); callbacks.forEach(callback => callback(0));},
    flushTimers() {while (timers.length) timers.shift()();}, get reloadCount() {return reloadCount;}};
}

function item(id, done = false) {
  return {messageId: id, title: id, courseName: '仮想情報演習', source: 'inCampus',
    status: done ? '完了' : '未確認', dueType: 'unknown', displayDueGroupKey: done ? 'completed' : 'unknown',
    displayDueGroupCount: 1,
    displayDueGroupCourseCountsJson: JSON.stringify([['仮想情報演習', 1]])};
}
let passed = 0;
function test(name, run) {run(); passed++; console.log('PASS ' + name);}

test('home menu and bottom navigation show the requested destinations without the past-exam entry', () => {
  const home = fs.readFileSync(path.join(sourceDir, 'Home.html'), 'utf8');
  const index = fs.readFileSync(path.join(sourceDir, 'Index.html'), 'utf8');
  const nav = index.match(/<nav class="bottom-nav"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'bottom navigation exists');
  const labels = Array.from(nav[0].matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g), match => match[1].replace(/<[^>]*>/g, '').trim());
  assert.deepEqual(labels, ['ホーム', '課題通知', '大学からのお知らせ', '大学情報まとめ']);
  assert.doesNotMatch(home + nav[0], /過去問データベース/);
});

test('bottom navigation keeps the same labels and routes across home, assignments, and university notices', () => {
  const f = fixture();
  const home = f.document.getElementById('bottom-home-button');
  const assignments = f.document.getElementById('bottom-assignment-button');
  const university = f.document.getElementById('bottom-university-button');
  const summary = f.document.getElementById('bottom-summary-button');
  const buttons = [home, assignments, university, summary];
  const expectedLabels = ['ホーム', '課題通知', '大学からのお知らせ', '大学情報まとめ'];

  for (const screen of ['home', 'active', 'completed', 'university']) {
    vm.runInContext(`currentScreen = ${JSON.stringify(screen)}`, f.c);
    f.c.updateBottomNavState();
    assert.deepEqual(buttons.map(button => button.textContent), expectedLabels);
    assert.equal(summary.disabled, true);
    assert.equal(typeof home.onclick, 'function');
    assert.equal(typeof assignments.onclick, 'function');
    assert.equal(typeof university.onclick, 'function');
  }

  vm.runInContext("currentScreen = 'university'", f.c);
  f.c.updateBottomNavState();
  assert.equal(university.classList.contains('active'), true);
  assert.equal(home.classList.contains('active'), false);
  assert.equal(assignments.classList.contains('active'), false);
});

test('a new personal workbook starts one background import and rereads the selected notice view after it completes', () => {
  const f = fixture(null, {holdBoot: true, initialRoute: 'university', initialSyncPending: true});
  const initialRead = f.take('getUniversityNoticePayloadForWeb');
  f.reply(initialRead, []);
  const sync = f.take('bootstrapInitialPersonalDataForWeb');
  f.reply(sync, {started: true, completed: true, apiSuccess: true, gmailSuccess: true,
    apiCourseworkCount: 4, savedCount: 2, testCaseModeEnabled: false});
  const refreshedRead = f.take('getUniversityNoticePayloadForWeb');
  assert.notEqual(refreshedRead, initialRead);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /初回同期完了/);
});

test('first-run personal import leaves the fixed test-case display in place', () => {
  const f = fixture(null, {holdBoot: true, initialSyncPending: true});
  const initialRead = f.take('getTaskDisplayPayloadForWeb');
  f.reply(initialRead, [item('fixture-task')]);
  const sync = f.take('bootstrapInitialPersonalDataForWeb');
  f.reply(sync, {started: true, completed: true, apiSuccess: true, gmailSuccess: true,
    apiCourseworkCount: 4, savedCount: 2, testCaseModeEnabled: true});
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length, 0);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /テスト表示は維持/);
});

test('initial deep links request only the matching page data', () => {
  const university = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  assert.equal(university.pending('getUniversityNoticePayloadForWeb').length, 1);
  assert.equal(university.pending('getTaskDisplayPayloadForWeb').length, 0);
  assert.equal(university.pending('getTaskDisplayPayloadForWeb').length, 0);

  const assignment = fixture(undefined, {holdBoot: true, initialRoute: 'assignment'});
  assert.equal(assignment.pending('getTaskDisplayPayloadForWeb').length, 1);
  assert.equal(assignment.pending('getUniversityNoticePayloadForWeb').length, 0);

  const home = fixture(undefined, {holdBoot: true});
  assert.equal(home.pending('getTaskDisplayPayloadForWeb').length, 1);
  assert.equal(home.pending('getUniversityNoticePayloadForWeb').length, 0);
  assert.equal(university.calls.some(call => call.method === 'getTestCaseClockStateForWeb'), false,
    'page boot must not send a second test-clock RPC');
  assert.equal(assignment.calls.some(call => call.method === 'getTestCaseClockStateForWeb'), false,
    'page boot must not wait for a separate test-clock RPC');
});

test('university to home to assignment loads the task list and reuses the in-flight read', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  f.reply(f.take('getUniversityNoticePayloadForWeb'), {items: [], cacheToken: '', testCaseClockState: {}});
  f.c.showHomeView();
  const taskRead = f.take('getTaskDisplayPayloadForWeb', '未完了');
  f.c.loadNotifications();
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '未完了').length, 1,
    'entering assignments while Home is loading must reuse the same task read');
  f.reply(taskRead, {items: [item('university-home-assignment')], cacheToken: '', testCaseClockState: {}});
  assert.equal(f.read('currentScreen'), 'active');
  assert.deepEqual(f.ids('notificationData.active'), ['university-home-assignment']);
  assert.ok(f.document.getElementById('list').children.length > 0);
  assert.doesNotMatch(f.document.getElementById('list').textContent, /一覧データの形式を確認できませんでした/);
});

test('invalid task payload falls back to the compatible array endpoint', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  f.reply(f.take('getUniversityNoticePayloadForWeb'), {items: [], cacheToken: '', testCaseClockState: {}});
  f.c.showHomeView();
  const taskRead = f.take('getTaskDisplayPayloadForWeb', '未完了');
  f.reply(taskRead, null);
  const fallback = f.take('getNotificationsForWeb');
  f.reply(fallback, [item('compatible-task')]);
  assert.deepEqual(f.ids('notificationData.active'), ['compatible-task']);
  assert.doesNotMatch(f.document.getElementById('list').textContent, /一覧データの形式を確認できませんでした/);
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length, 0);
});

test('invalid completed payload falls back to the completed array endpoint', () => {
  const f = fixture(undefined, {holdBoot: true});
  f.c.loadCompletedNotifications();
  const completedRead = f.take('getTaskDisplayPayloadForWeb', '完了');
  f.reply(completedRead, null);
  const fallback = f.take('getCompletedNotificationsForWeb');
  f.reply(fallback, [item('compatible-completed-task', true)]);
  assert.deepEqual(f.ids('notificationData.completed'), ['compatible-completed-task']);
  assert.equal(f.read('currentScreen'), 'completed');
  assert.doesNotMatch(f.document.getElementById('list').textContent, /一覧データの形式を確認できませんでした/);
});

test('embedded initial payload renders each entry route without a page-load data RPC', () => {
  const clockState = {testCaseModeEnabled: true, testCaseClockDateTime: '2026-12-20T10:30',
    testCaseClockPresets: [{id: 'year-end', label: '年末'}]};
  const assignmentItem = item('embedded-assignment');
  const assignment = fixture(undefined, {holdBoot: true, initialRoute: 'assignment',
    initialPayload: {view: 'assignment', payload: {items: [assignmentItem], cacheToken: '', testCaseClockState: clockState}}});
  assert.deepEqual(assignment.calls.map(call => call.method), []);
  assert.deepEqual(assignment.ids('notificationData.active'), ['embedded-assignment']);
  assert.equal(assignment.read('testCaseClockDateTime'), '2026-12-20T10:30');
  assert.ok(assignment.document.getElementById('list').children.length > 0);

  const homeItem = item('embedded-home');
  const home = fixture(undefined, {holdBoot: true,
    initialPayload: {view: 'home', payload: {items: [homeItem], cacheToken: '', testCaseClockState: clockState}}});
  assert.deepEqual(home.calls.map(call => call.method), []);
  assert.deepEqual(home.ids('notificationData.active'), ['embedded-home']);
  assert.equal(home.read('notificationDataLoaded.active'), true);

  const universityItem = {messageId: 'embedded-notice', title: '初期HTMLのお知らせ', source: 'inCampus',
    receivedAt: '2026/12/20 10:00', receivedAtTime: 1, body: '仮想のお知らせ', read: false, saved: false};
  const university = fixture(undefined, {holdBoot: true, initialRoute: 'university',
    initialPayload: {view: 'university', payload: {items: [universityItem], cacheToken: '', testCaseClockState: clockState}}});
  assert.deepEqual(university.calls.map(call => call.method), []);
  assert.equal(university.read('universityState.loaded'), true);
  assert.equal(university.read('universityState.items[0].messageId'), 'embedded-notice');
  assert.equal(university.read('testCaseClockDateTime'), '2026-12-20T10:30');
});

test('invalid university preload falls back to a valid server response before showing a format error', () => {
  const f = fixture(undefined, {holdBoot: true, initialPayload: {
    view: 'home', payload: {items: [item('home-task')], cacheToken: '', testCaseClockState: {}}
  }});
  f.c.showUniversityNotices(null);
  const payloadRequest = f.take('getUniversityNoticePayloadForWeb');
  f.reply(payloadRequest, null);
  const compatibilityRequest = f.take('getUniversityNoticesForWeb');
  const notice = {messageId: 'rpc-notice', title: '大学のお知らせ', source: 'inCampus',
    receivedAt: '2026/10/07 10:00', receivedAtTime: 1, body: '本文', read: false, saved: false};
  f.reply(compatibilityRequest, [notice]);
  assert.equal(f.read('universityState.loaded'), true);
  assert.equal(f.read('universityState.items[0].messageId'), 'rpc-notice');
  assert.doesNotMatch(f.document.getElementById('un-status').textContent, /形式を確認できません/);
});

test('university list retries when its prepared sheet is briefly being replaced by background sync', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  const first = f.take('getUniversityNoticePayloadForWeb');
  first.settled = true;
  first.failure(new Error('大学通知表示データを更新中です。表示データの更新後に再試行します。'));
  assert.equal(f.read('universityState.loading'), true, 'the list remains in loading state during a transient write');
  f.flushTimers();
  const retry = f.take('getUniversityNoticePayloadForWeb');
  f.reply(retry, {items: [{messageId: 'retry-notice', title: '再試行で取得', preview: '要約',
    source: 'inCampus', receivedAt: '2026/10/09 10:00', from: '', read: false, saved: false}], cacheToken: 'new-generation'});
  assert.equal(f.read('universityState.loaded'), true);
  assert.equal(f.read('universityState.items[0].messageId'), 'retry-notice');
  assert.match(f.document.getElementById('un-status').textContent, /未読・保存状態/);
});

test('task list retries a cacheless prepared-sheet read that overlaps the short write phase', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'assignment'});
  const first = f.take('getTaskDisplayPayloadForWeb', '未完了');
  first.settled = true;
  first.failure(new Error('課題表示データを更新中です。表示データの更新後に再試行します。'));
  f.flushTimers();
  const retry = f.take('getTaskDisplayPayloadForWeb', '未完了');
  f.reply(retry, {items: [item('retry-task')], testCaseClockState: {testCaseModeEnabled: false}});
  assert.deepEqual(f.ids('notificationData.active'), ['retry-task']);
  assert.ok(f.document.getElementById('list').children.length > 0);
  assert.doesNotMatch(f.document.getElementById('list').textContent, /更新中/);
});

test('the initial data response supplies test-clock state without triggering another list read', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'assignment'});
  const boot = f.take('getTaskDisplayPayloadForWeb');
  f.reply(boot, {items: [item('virtual-task')], testCaseClockState: {
    testCaseModeEnabled: true,
    testCaseClockDateTime: '2026-12-20T10:30',
    testCaseClockPresets: [{id: 'year-end', label: '年末'}]
  }});
  assert.equal(f.read('testCaseModeEnabled'), true);
  assert.equal(f.read('testCaseClockDateTime'), '2026-12-20T10:30');
  assert.deepEqual(f.calls.map(call => call.method), ['getTaskDisplayPayloadForWeb']);
});

test('navigating to each page calls only its matching list endpoint', () => {
  const f = fixture();
  const start = f.calls.length;
  f.c.showUniversityNotices();
  assert.deepEqual(f.calls.slice(start).map(call => call.method), ['getUniversityNoticePayloadForWeb']);
  const afterUniversity = f.calls.length;
  f.c.loadNotifications();
  assert.deepEqual(f.calls.slice(afterUniversity).map(call => call.method), ['getTaskDisplayPayloadForWeb']);
  const afterAssignments = f.calls.length;
  f.c.loadCompletedNotifications();
  assert.deepEqual(f.calls.slice(afterAssignments).map(call => call.method), ['getTaskDisplayPayloadForWeb']);
  assert.equal(f.calls.slice(afterAssignments)[0].args[0], '完了');
});

test('assignment navigation reuses an in-flight home read instead of starting a duplicate', () => {
  const f = fixture(undefined, {holdBoot: true});
  const boot = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadNotifications();
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '未完了').length, 1);
  assert.equal(f.document.getElementById('list').textContent, '読み込み中...');
  f.reply(boot, [item('one-read')]);
  assert.deepEqual(f.ids('currentRawData'), ['one-read']);
});

test('cached assignment data renders immediately while a background read refreshes it', () => {
  const f = fixture();
  f.c.setNotificationData([item('FAST-ACTIVE')], 'active');
  const before = f.calls.length;
  f.c.loadNotifications();
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length, 1);
  assert.equal(f.calls.slice(before).at(-1).method, 'getTaskDisplayPayloadForWeb');
  assert.notEqual(f.document.getElementById('list').textContent, '読み込み中...');
  assert.ok(f.document.getElementById('list').children.length > 0);
});

test('university notice list omits full bodies and fetches a body only when a notice is selected', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  const initial = f.take('getUniversityNoticePayloadForWeb');
  const body = '本文'.repeat(200);
  const notice = {messageId: 'FAST-NOTICE', title: '仮想連絡', preview: body.slice(0, 179) + '…', source: 'inCampus', receivedAt: '', from: '', read: false, saved: false};
  f.reply(initial, {items: [notice], cacheToken: 'notice-generation-1'});
  const list = f.document.getElementById('un-list');
  let firstCard = list.children[0];
  assert.ok(firstCard.children[2].textContent.length <= 180, 'list preview stays compact');
  assert.equal(vm.runInContext("Object.prototype.hasOwnProperty.call(universityState.items[0], 'body')", f.c), false, 'the initial client data does not contain the full body');
  assert.equal(f.pending('getUniversityNoticeBodyForWeb').length, 0, 'list boot does not request detail bodies');
  firstCard.onclick();
  firstCard = list.children[0];
  const bodyRequest = f.take('getUniversityNoticeBodyForWeb');
  assert.deepEqual(bodyRequest.args, [notice.messageId]);
  f.reply(bodyRequest, {found: true, messageId: notice.messageId, body});
  assert.equal(f.document.getElementById('un-detail').children[4].textContent, body);

  const before = f.calls.length;
  let renderCount = 0;
  const originalRender = f.c.renderUniversityNotices;
  f.c.renderUniversityNotices = (...args) => {renderCount++; return originalRender(...args);};
  f.c.showUniversityNotices();
  assert.equal(f.pending('getUniversityNoticePayloadForWeb').length, 1);
  assert.equal(f.calls.slice(before).at(-1).method, 'getUniversityNoticePayloadForWeb');
  assert.equal(renderCount, 0);
  assert.notEqual(f.document.getElementById('un-status').textContent, 'お知らせを読み込み中…');
  assert.equal(f.document.getElementById('un-list').children.length, 1);
  const readNotice = {...notice, read: true};
  f.reply(f.take('getUniversityNoticePayloadForWeb'), {items: [readNotice], cacheToken: 'notice-generation-1'});
  assert.equal(renderCount, 0, 'unchanged list DOM is reused after the background response');
  assert.equal(f.document.getElementById('un-list').children[0], firstCard);
  f.c.showUniversityNotices();
  const updated = {...readNotice, preview: '更新後の本文抜粋'};
  f.reply(f.take('getUniversityNoticePayloadForWeb'), {items: [updated], cacheToken: 'notice-generation-2'});
  assert.equal(renderCount, 1, 'changed compact list content triggers a list update');
  assert.notEqual(f.document.getElementById('un-list').children[0], firstCard);
  assert.equal(f.pending('getUniversityNoticeBodyForWeb').length, 1, 'a new display generation invalidates the old full body');
  assert.equal(f.document.getElementById('un-detail').children[4].textContent, '本文を読み込み中…');
});

test('university notice search queries full server-side bodies and keeps the result in the compact list', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  const initial = f.take('getUniversityNoticePayloadForWeb');
  const notice = {messageId: 'BODY-SEARCH-001', title: '一般連絡', preview: '通常の抜粋', source: 'inCampus', receivedAt: '', from: '', read: false, saved: false};
  f.reply(initial, {items: [notice], cacheToken: 'search-generation'});
  f.document.getElementById('un-search').value = '本文の奥にある語';
  f.c.handleUniversitySearchInput();
  f.flushTimers();
  const search = f.take('searchUniversityNoticesForWeb');
  assert.deepEqual(search.args, ['本文の奥にある語']);
  f.reply(search, {query: '本文の奥にある語', messageIds: [notice.messageId]});
  assert.equal(f.document.getElementById('un-list').children.length, 1);
  assert.equal(f.document.getElementById('un-count').textContent.startsWith('1件'), true);
});

test('task display cache write waits for paint while university list opening does no background body read', () => {
  const task = fixture(undefined, {holdBoot: true});
  const taskRead = task.take('getTaskDisplayPayloadForWeb');
  const taskItem = item('AFTER-PAINT-TASK');
  task.reply(taskRead, {items: [taskItem], cacheToken: 'task-cache-token'});
  assert.equal(task.pending('cacheTaskDisplayItemsAfterWebDisplay').length, 0);
  task.flushAnimationFrame();
  assert.equal(task.pending('cacheTaskDisplayItemsAfterWebDisplay').length, 0);
  task.flushAnimationFrame();
  const taskCache = task.take('cacheTaskDisplayItemsAfterWebDisplay');
  assert.deepEqual(taskCache.args, [[taskItem], 'active', 'task-cache-token']);

  const university = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  const noticeRead = university.take('getUniversityNoticePayloadForWeb');
  const notice = {messageId: 'AFTER-PAINT-NOTICE', title: '仮想連絡', preview: '本文抜粋', read: false, saved: false};
  const before = university.calls.length;
  university.reply(noticeRead, {items: [notice], cacheToken: 'notice-cache-token'});
  university.flushAnimationFrame();
  university.flushAnimationFrame();
  assert.deepEqual(university.calls.slice(before).map(call => call.method), [],
    'rendered notice lists must not issue a background full-body cache request');
  assert.equal(university.pending('getUniversityNoticeBodyForWeb').length, 0,
    'notice bodies are fetched only after a card is selected');
});

test('a sync-warmed task cache response skips the redundant post-display cache RPC', () => {
  const f = fixture(undefined, {holdBoot: true});
  const initial = f.take('getTaskDisplayPayloadForWeb');
  f.reply(initial, {items: [item('SYNC-WARMED-TASK')], cacheToken: ''});
  f.flushAnimationFrame();
  f.flushAnimationFrame();
  assert.deepEqual(f.calls.map(call => call.method), ['getTaskDisplayPayloadForWeb', 'getUniversityNoticePayloadForWeb']);
  assert.equal(f.pending('cacheTaskDisplayItemsAfterWebDisplay').length, 0);
});

test('discovering test mode invalidates old client data and rejects the old source reply', () => {
  const f = fixture(undefined, {holdBoot: true});
  const old = f.take('getTaskDisplayPayloadForWeb');
  f.c.setNotificationData([item('LIVE-TASK')], 'active');
  f.c.applyTestCaseClockState({testCaseModeEnabled: true, testCaseClockDateTime: '', testCaseClockPresets: []});
  assert.deepEqual(f.ids('notificationData.active'), []);
  const fresh = f.pending('getTaskDisplayPayloadForWeb').at(-1);
  assert.notEqual(fresh, old);
  f.reply(fresh, [item('SIM-TASK')]);
  f.reply(old, [item('STALE-LIVE-TASK')]);
  assert.deepEqual(f.ids('notificationData.active'), ['SIM-TASK']);
});

test('an unexpected non-array list result is reported instead of shown as an empty list', () => {
  const f = fixture(undefined, {holdBoot: true});
  const boot = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadNotifications();
  f.reply(boot, {});
  f.reply(f.take('getNotificationsForWeb'), null);
  assert.match(f.document.getElementById('list').textContent, /形式を確認できませんでした/);
  assert.ok(f.document.getElementById('home-sync-text').textContent.startsWith('一覧の読み込みに失敗しました'));
});

test('an unexpected non-array university result keeps an explicit read error instead of a false empty state', () => {
  const f = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  const read = f.take('getUniversityNoticePayloadForWeb');
  f.reply(read, {});
  const fallback = f.take('getUniversityNoticesForWeb');
  f.reply(fallback, {});
  assert.match(f.document.getElementById('un-status').textContent, /形式を確認できませんでした/);
  assert.equal(f.document.getElementById('un-count').textContent, '');
});

test('assignment hamburger drawer routes unfinished, completed, and search while tracking selection', () => {
  const index = fs.readFileSync(path.join(sourceDir, 'Index.html'), 'utf8');
  const header = index.match(/<header class="assignment-header">([\s\S]*?)<\/header>/);
  const drawer = index.match(/<nav id="assignment-menu-drawer"[\s\S]*?<\/nav>/);
  assert.ok(header && header[1].includes('assignment-menu-toggle'));
  assert.ok(header[1].indexOf('assignment-menu-toggle') < header[1].indexOf('課題通知Hub'));
  assert.ok(drawer);
  const destinations = Array.from(drawer[0].matchAll(/<button id="assignment-menu-[^"]+"[^>]*>([\s\S]*?)<\/button>/g), match => match[1].replace(/<[^>]*>/g, '').trim());
  assert.deepEqual(destinations, ['○未完了', '✓完了', '⌕検索']);

  const f = fixture();
  f.seed([item('active')], [item('done', true)]);
  const navActive = f.document.getElementById('assignment-menu-active');
  const navCompleted = f.document.getElementById('assignment-menu-completed');
  const navSearch = f.document.getElementById('assignment-menu-search');
  const assignmentDrawer = f.document.getElementById('assignment-menu-drawer');

  f.c.toggleAssignmentMenu();
  assert.equal(assignmentDrawer.classList.contains('is-open'), true);
  assert.equal(assignmentDrawer.inert, false);
  assert.equal(f.document.getElementById('assignment-menu-toggle')['aria-expanded'], 'true');
  assert.equal(navActive.classList.contains('active'), true);

  f.c.selectAssignmentMenu('completed');
  assert.equal(f.read('currentScreen'), 'completed');
  assert.equal(navCompleted.classList.contains('active'), true);
  assert.equal(assignmentDrawer.inert, true);
  assert.ok(f.pending('getTaskDisplayPayloadForWeb').length);

  f.c.selectAssignmentMenu('search');
  assert.equal(f.document.getElementById('course-filter-panel').classList.contains('is-open'), true);
  assert.equal(navSearch.classList.contains('active'), true);
  f.c.selectCourseFilter('仮想情報演習');
  assert.equal(f.document.getElementById('course-filter-panel').classList.contains('is-open'), false);
  assert.equal(navSearch.classList.contains('active'), true);

  f.c.selectAssignmentMenu('active');
  assert.equal(f.read('currentScreen'), 'active');
  assert.equal(navActive.classList.contains('active'), true);
  assert.equal(navSearch.classList.contains('active'), true);
});

test('reverse active/completed replies preserve completed screen and home cache', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadNotifications();
  f.c.loadCompletedNotifications(); const completed = f.take('getTaskDisplayPayloadForWeb');
  f.reply(completed, [item('done', true)]); f.reply(boot, [item('active')]);
  assert.equal(f.read('currentScreen'), 'completed');
  assert.equal(f.read('currentViewMode'), 'completed');
  assert.deepEqual(f.ids('currentRawData'), ['done']);
  assert.deepEqual(f.ids('homeRawData'), ['active']);
});

test('newest refresh wins over boot read and prior list request', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadNotifications();
  f.c.manualRefreshNotifications();
  const fresh = f.pending('syncAndGetNotificationsForWeb').at(-1);
  f.reply(fresh, {items: [item('new')], testCaseModeEnabled: false, savedCount: 1}); f.reply(boot, [item('boot')]);
  assert.deepEqual(f.ids('currentRawData'), ['new']); assert.deepEqual(f.ids('homeRawData'), ['new']);
});

test('an in-flight completed read is reused after navigating away and back', () => {
  const f = fixture();
  f.c.loadCompletedNotifications(); const old = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadNotifications(); const active = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadCompletedNotifications();
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '完了').length, 1);
  f.reply(active, [item('active')]); f.reply(old, [item('done', true)]);
  assert.deepEqual(f.ids('currentRawData'), ['done']); assert.equal(f.read('currentViewMode'), 'completed');
});

test('a background active response preserves the completed loading indicator', () => {
  const f = fixture(); f.c.loadNotifications(); const active = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadCompletedNotifications();
  f.reply(active, [item('active')]);
  assert.equal(f.document.getElementById('list').textContent, '完了済み一覧を読み込み中...');
  assert.deepEqual(f.ids('homeRawData'), ['active']);
});

test('home and university navigation survive background assignment responses', () => {
  const f = fixture();
  f.c.loadNotifications(); const active = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadCompletedNotifications(); const completed = f.take('getTaskDisplayPayloadForWeb');
  f.c.showHomeView(); f.reply(completed, [item('done', true)]);
  assert.equal(f.read('currentViewMode'), 'active'); assert.equal(f.read('currentScreen'), 'home');
  f.c.showUniversityNotices(); const university = f.take('getUniversityNoticePayloadForWeb');
  f.reply(active, [item('active')]); f.reply(university, []);
  assert.equal(f.read('currentScreen'), 'university');
  assert.ok(f.document.getElementById('university-view').classList.contains('is-active'));
  f.c.showHomeView(); assert.deepEqual(f.ids('homeRawData'), ['active']);
});

test('stale failures cannot replace newer data or another screen with an error', () => {
  const f = fixture(); f.c.loadNotifications(); const old = f.take('getTaskDisplayPayloadForWeb');
  f.c.manualRefreshNotifications(); const fresh = f.pending('syncAndGetNotificationsForWeb').at(-1);
  f.reply(fresh, {items: [item('new')], testCaseModeEnabled: false, savedCount: 1}); f.fail(old);
  assert.deepEqual(f.ids('currentRawData'), ['new']);
  assert.ok(!f.document.getElementById('list').textContent.includes('エラー'));
  f.c.loadNotifications(); const active = f.take('getTaskDisplayPayloadForWeb');
  f.c.loadCompletedNotifications(); f.fail(active);
  assert.equal(f.document.getElementById('list').textContent, '完了済み一覧を読み込み中...');
  f.fail(f.take('getTaskDisplayPayloadForWeb'));
  assert.match(f.document.getElementById('list').textContent, /エラー.*offline/);
});

test('done immediately updates the home count and stale reads cannot resurrect it', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.refreshNotifications(); const before = f.pending('getTaskDisplayPayloadForWeb').at(-1);
  f.c.markAsDone('A'); assert.deepEqual(f.ids('homeRawData'), []);
  f.reply(before, [item('A')]); assert.deepEqual(f.ids('currentRawData'), []);
  f.c.manualRefreshNotifications(); const during = f.pending('syncAndGetNotificationsForWeb').at(-1);
  f.reply(during, {items: [item('A')], testCaseModeEnabled: false, savedCount: 0}); assert.deepEqual(f.ids('homeRawData'), []);
  f.reply(f.take('markNotificationDone', 'A'), [item('A')]);
  assert.deepEqual(f.ids('homeRawData'), []);
});

test('undo before done reply waits for done, then sends exactly one undo', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.c.undoLastDone();
  assert.equal(f.pending('markNotificationUndone', 'A').length, 0);
  assert.deepEqual(f.ids('homeRawData'), ['A']);
  f.reply(f.take('markNotificationDone', 'A'));
  assert.equal(f.pending('markNotificationUndone', 'A').length, 1);
  f.reply(f.take('markNotificationUndone', 'A'));
  assert.equal(f.read('notificationStatusChanges.size'), 0);
  assert.deepEqual(f.ids('homeRawData'), ['A']);
});

test('undo after done reply does not cancel the next completion', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.reply(f.take('markNotificationDone', 'A'));
  f.c.undoLastDone(); f.reply(f.take('markNotificationUndone', 'A'));
  f.c.markAsDone('A'); f.reply(f.take('markNotificationDone', 'A'));
  assert.equal(f.pending('markNotificationUndone', 'A').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'markNotificationUndone').length, 1);
  assert.equal(f.read('notificationStatusChanges.size'), 0);
  assert.deepEqual(f.ids('homeRawData'), []);
});

test('done undo redone before the first reply coalesces to final done', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.c.undoLastDone(); f.c.markAsDone('A');
  assert.equal(f.pending('markNotificationDone', 'A').length, 1);
  f.reply(f.take('markNotificationDone', 'A'));
  assert.equal(f.calls.filter(call => call.method === 'markNotificationUndone').length, 0);
  assert.deepEqual(f.ids('homeRawData'), []);
});

test('redone during undo waits and leaves server operations in done undo done order', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.reply(f.take('markNotificationDone', 'A'));
  f.c.undoLastDone(); f.c.markAsDone('A');
  assert.equal(f.pending('markNotificationDone', 'A').length, 0);
  f.reply(f.take('markNotificationUndone', 'A'));
  assert.equal(f.pending('markNotificationDone', 'A').length, 1);
  f.reply(f.take('markNotificationDone', 'A'));
  assert.deepEqual(f.calls.filter(call => call.method.startsWith('mark')).map(call => call.method),
    ['markNotificationDone', 'markNotificationUndone', 'markNotificationDone']);
  assert.deepEqual(f.ids('homeRawData'), []);
});

test('multiple done responses arriving in reverse cannot resurrect another done item', () => {
  const f = fixture(); f.seed([item('A'), item('B')]);
  f.c.markAsDone('A'); f.c.markAsDone('B');
  f.reply(f.take('markNotificationDone', 'B'), [item('A')]);
  f.reply(f.take('markNotificationDone', 'A'), [item('B')]);
  assert.deepEqual(f.ids('currentRawData'), []); assert.deepEqual(f.ids('homeRawData'), []);
  assert.deepEqual(f.ids('notificationData.completed'), ['A', 'B']);
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '未完了').length, 1);
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '完了').length, 1);
});

test('latest toast undoes only the last task while another completion is pending', () => {
  const f = fixture(); f.seed([item('A'), item('B')]);
  f.c.markAsDone('A'); f.c.markAsDone('B'); f.c.undoLastDone();
  f.reply(f.take('markNotificationDone', 'B')); f.reply(f.take('markNotificationUndone', 'B'));
  f.reply(f.take('markNotificationDone', 'A'));
  assert.deepEqual(f.ids('homeRawData'), ['B']);
  assert.deepEqual(f.ids('notificationData.completed'), ['A']);
});

test('status callbacks preserve navigation and refresh both caches after writes', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.c.showUniversityNotices();
  f.reply(f.take('markNotificationDone', 'A'));
  f.reply(f.take('getTaskDisplayPayloadForWeb', '完了'), [item('A', true)]);
  f.reply(f.take('getTaskDisplayPayloadForWeb', '未完了'), []);
  assert.equal(f.read('currentScreen'), 'university');
  f.c.showAssignmentView('completed'); f.c.markAsUndone('A'); f.c.showHomeView();
  f.reply(f.take('markNotificationUndone', 'A'));
  f.reply(f.take('getTaskDisplayPayloadForWeb', '未完了'), [item('A')]);
  f.reply(f.take('getTaskDisplayPayloadForWeb', '完了'), []);
  assert.equal(f.read('currentScreen'), 'home'); assert.equal(f.read('currentViewMode'), 'active');
  assert.deepEqual(f.ids('homeRawData'), ['A']);
});

test('failed done rolls back locally and retries reads without navigating', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.c.showHomeView(); f.fail(f.take('markNotificationDone', 'A'));
  assert.deepEqual(f.ids('homeRawData'), ['A']); assert.equal(f.read('currentScreen'), 'home');
  assert.equal(f.read('notificationStatusChanges.size'), 0); assert.equal(f.alerts.length, 1);
  assert.equal(f.read('lastUndoMessageId'), '');
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '未完了').length, 1);
  assert.equal(f.pending('getTaskDisplayPayloadForWeb', '完了').length, 1);
});

test('failed undo restores completed state and does not leave a queued undo', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.reply(f.take('markNotificationDone', 'A'));
  f.c.undoLastDone(); f.fail(f.take('markNotificationUndone', 'A'));
  assert.deepEqual(f.ids('homeRawData'), []);
  assert.deepEqual(f.ids('notificationData.completed'), ['A']);
  assert.equal(f.read('notificationStatusChanges.size'), 0); assert.equal(f.alerts.length, 1);
});

test('a failed earlier write still sends the newer intent explicitly', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.c.undoLastDone(); f.fail(f.take('markNotificationDone', 'A'));
  assert.equal(f.alerts.length, 0); assert.equal(f.pending('markNotificationUndone', 'A').length, 1);
  f.reply(f.take('markNotificationUndone', 'A'));
  assert.deepEqual(f.ids('homeRawData'), ['A']); assert.equal(f.read('notificationStatusChanges.size'), 0);
});

test('assignment rendering trusts stored group metadata and incoming order without date classification or sorting', () => {
  const f = fixture(Date.parse('2026-10-08T10:30:00+09:00'));
  const rows = [
    {...item('prepared-first'), title: '準備済み先頭', dueType: 'detected', dueDateKey: '2099-10-08', displayDueGroupKey: 'today', displayDueGroupCount: 2},
    {...item('prepared-second'), title: '準備済み次点', dueType: 'detected', dueDateKey: '2026-10-09', displayDueGroupKey: 'today', displayDueGroupCount: 2, displayDueGroupCourseCountsJson: ''},
    {...item('prepared-third'), title: '準備済み次週', dueType: 'detected', dueDateKey: '2026-10-10', displayDueGroupKey: 'later', displayDueGroupCount: 1}
  ];
  f.seed(rows);
  const list = f.document.getElementById('list');
  const groupTitles = list.children.filter(child => child.className.startsWith('group-title'))
    .map(child => child.innerHTML.match(/group-label\">([^<]*)</)[1]);
  const cardTitles = list.children.filter(child => child.className === 'group-body')
    .flatMap(group => group.children)
    .map(card => (card.innerHTML.match(/<div class="title">([^<]*)<\/div>/) || [])[1]);
  assert.deepEqual(groupTitles, ['今日まで', '来週以降']);
  assert.deepEqual(cardTitles, ['準備済み先頭', '準備済み次点', '準備済み次週']);
  assert.equal(typeof f.c.getDueGroupKey, 'undefined');
  assert.equal(typeof f.c.groupNotificationsByDue, 'undefined');
  const renderer = fs.readFileSync(path.join(sourceDir, 'ScriptsRendering.html'), 'utf8');
  assert.doesNotMatch(renderer, /countsByGroup/);
  assert.match(renderer, /displayDueGroupCount/);
});

test('Home renders saved group and course counts without regrouping or recounting notification rows', () => {
  const f = fixture();
  const rows = [
    {...item('home-today-1'), displayDueGroupKey: 'today', displayDueGroupCount: 3,
      displayDueGroupCourseCountsJson: JSON.stringify([['仮想A', 2], ['仮想B', 1]])},
    {...item('home-today-2'), displayDueGroupKey: 'today', displayDueGroupCount: 3,
      displayDueGroupCourseCountsJson: ''},
    {...item('home-today-3'), displayDueGroupKey: 'today', displayDueGroupCount: 3,
      displayDueGroupCourseCountsJson: ''}
  ];
  f.c.setNotificationData(rows, 'active');
  f.c.showHomeView();
  const html = f.document.getElementById('home-due-card').innerHTML;
  assert.match(html, /今日まで/);
  assert.match(html, /3件/);
  assert.match(html, /仮想A/);
  assert.match(html, /2件/);
  const homeScript = fs.readFileSync(path.join(sourceDir, 'ScriptsHome.html'), 'utf8');
  assert.doesNotMatch(homeScript, /homeRawData\.forEach/);
  assert.match(homeScript, /displayDueGroupCourseCountsJson/);
});

test('completed rendering keeps the sync-provided completion order', () => {
  const f = fixture();
  const rows = [
    {...item('completed-newer', true), completedAtTime: 200},
    {...item('completed-older', true), completedAtTime: 100}
  ];
  f.c.setNotificationData(rows, 'completed');
  f.c.showAssignmentView('completed');
  const cardTitles = f.document.getElementById('list').children
    .filter(child => child.className === 'group-body')
    .flatMap(group => group.children)
    .map(card => (card.innerHTML.match(/<div class="title">([^<]*)<\/div>/) || [])[1]);
  assert.deepEqual(cardTitles, ['completed-newer', 'completed-older']);
});

test('changing the selected test clock refetches the projection so server-side groups can be regenerated', () => {
  const f = fixture(undefined, {holdBoot: true});
  const firstRead = f.take('getTaskDisplayPayloadForWeb');
  f.reply(firstRead, []);
  f.c.applyTestCaseClockState({testCaseModeEnabled: true, testCaseClockDateTime: '2026-12-31T23:58', testCaseClockPresets: []});
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length, 1);
  assert.equal(f.take('getTaskDisplayPayloadForWeb').args[0], '未完了');
});

test('settings switch data sources in place, read the selected source, and do not start mail sync', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getTaskDisplayPayloadForWeb');f.c.openSecurityModal();
  f.reply(f.take('getSecuritySettingsForWeb'), {hasApiToken: true, tokenPreview: '••••', postAuthRequired: true,
    testCaseModeEnabled: false, testSpreadsheetReady: true});
  const toggle = f.document.getElementById('test-mode-toggle');
  assert.equal(toggle.checked, false);assert.equal(toggle.disabled, false);
  assert.match(f.document.getElementById('test-mode-hint').textContent, /固定テストシート/);
  assert.match(f.document.getElementById('test-mode-hint').textContent, /保存先は元の個人Excel/);
  f.c.toggleTestCaseMode(true);assert.deepEqual(f.take('setTestCaseModeForWeb').args, [true]);
  f.reply(f.take('setTestCaseModeForWeb'), {hasApiToken: true, tokenPreview: '••••', postAuthRequired: true,
    testCaseModeEnabled: true, testSpreadsheetReady: true});
  const selectedSourceRead = f.pending('getTaskDisplayPayloadForWeb').at(-1);
  f.reply(selectedSourceRead, [item('SIM-001')]);
  f.reply(boot, [item('OLD-LIVE')]);
  assert.equal(toggle.checked, true);assert.equal(f.document.getElementById('test-mode-status').textContent, 'ON：テストケース用データを表示中');
  assert.match(f.document.getElementById('test-mode-hint').textContent, /利用者ごとに保持/);
  assert.match(f.document.getElementById('security-message').textContent, /1件を読み込み/);
  assert.match(f.document.getElementById('security-message').textContent, /メール同期は実行していません/);
  assert.equal(f.reloadCount, 0);
  assert.equal(f.calls.filter(call => call.method === 'refreshAndGetNotificationsForWeb').length, 0);
});

test('test date presets stay independent from the data-source toggle and the header picker is ON-only', () => {
  const f = fixture(Date.parse('2026-10-08T10:30:00+09:00'), {holdBoot: true});
  const presets = [
    {id: 'saturday', label: '2026/12/26（土）', dateTime: '2026-12-26T09:00'},
    {id: 'year-end', label: '2026/12/31（木）', dateTime: '2026-12-31T23:58'},
    {id: 'leap-day', label: '2028/02/29（火）', dateTime: '2028-02-29T09:00'}
  ];
  f.c.showAssignmentView('active');
  f.c.renderTestCaseClockSettings({testCaseClockDateTime: '2026-12-31T23:58', testCaseClockPresets: presets});
  assert.match(f.document.getElementById('settings-test-clock-preset').innerHTML, /saturday/);
  assert.match(f.document.getElementById('settings-test-clock-preset').innerHTML, /year-end/);
  assert.equal(f.document.getElementById('settings-test-clock-preset').value, 'year-end');
  f.c.renderTestCaseModeSettings({testCaseModeEnabled: false, testSpreadsheetReady: true});
  assert.equal(f.document.getElementById('header-test-clock-button').hidden, true);
  f.c.openTestClockModal();assert.equal(f.document.getElementById('test-clock-modal-backdrop').classList.contains('is-open'), false);
  f.c.renderTestCaseModeSettings({testCaseModeEnabled: true, testSpreadsheetReady: true});
  assert.equal(f.document.getElementById('header-test-clock-button').hidden, false);
  f.c.openTestClockModal();assert.equal(f.document.getElementById('test-clock-modal-backdrop').classList.contains('is-open'), true);
  const headerSelect = f.document.getElementById('header-test-clock-preset');headerSelect.value = 'leap-day';
  f.c.applyTestClockSelection('header');
  assert.deepEqual(f.take('setTestCaseClockForWeb').args, ['2028-02-29T09:00']);
  f.reply(f.take('setTestCaseClockForWeb'), {testCaseModeEnabled: true, testCaseClockDateTime: '2028-02-29T09:00', testCaseClockPresets: presets});
  assert.equal(f.document.getElementById('header-test-clock-current').textContent, '設定中：2028/02/29 09:00（日本時間）');
  assert.ok(f.pending('getTaskDisplayPayloadForWeb').length > 0);
  assert.equal(f.pending('refreshAndGetNotificationsForWeb').length, 0);
  f.c.renderTestCaseModeSettings({testCaseModeEnabled: false, testSpreadsheetReady: true});
  assert.equal(f.document.getElementById('header-test-clock-button').hidden, true);
  assert.equal(f.document.getElementById('header-test-clock-current').textContent, '設定中：2028/02/29 09:00（日本時間）');
});

test('OFF switch returns to saved data with a read-only request, not a Gmail refresh', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getTaskDisplayPayloadForWeb');f.c.openSecurityModal();
  f.reply(f.take('getSecuritySettingsForWeb'), {hasApiToken: true, postAuthRequired: true,
    testCaseModeEnabled: true, testSpreadsheetReady: true});
  const toggle = f.document.getElementById('test-mode-toggle');toggle.checked = true;
  f.c.toggleTestCaseMode(false);
  f.reply(f.take('setTestCaseModeForWeb'), {hasApiToken: true, postAuthRequired: true,
    testCaseModeEnabled: false, testSpreadsheetReady: true});
  const savedRead = f.pending('getTaskDisplayPayloadForWeb').at(-1);
  f.reply(savedRead, [item('SAVED-001')]);
  f.reply(boot, [item('OLD-TEST')]);
  assert.equal(toggle.checked, false);
  assert.match(f.document.getElementById('security-message').textContent, /保存済みデータへ切り替えました/);
  assert.equal(f.calls.filter(call => call.method === 'refreshAndGetNotificationsForWeb').length, 0);
  assert.equal(f.reloadCount, 0);
});

test('startup and 15-minute polling read stored rows; explicit update performs API then Gmail sync', () => {
  const f = fixture(undefined, {holdBoot: true});
  const boot = f.take('getTaskDisplayPayloadForWeb');
  assert.equal(f.pending('refreshAndGetNotificationsForWeb').length, 0);
  f.reply(boot, [item('SAVED-001')]);

  f.c.refreshNotifications();
  const polling = f.pending('getTaskDisplayPayloadForWeb').at(-1);
  assert.equal(f.pending('refreshAndGetNotificationsForWeb').length, 0);
  f.reply(polling, [item('SAVED-002')]);

  f.c.manualRefreshNotifications();
  const sync = f.pending('syncAndGetNotificationsForWeb').at(-1);
  assert.equal(f.document.getElementById('manual-refresh-button').disabled, true);
  assert.equal(f.document.getElementById('list').textContent, '');
  assert.equal(f.document.getElementById('sync-toast').classList.contains('is-visible'), true);
  f.reply(sync, {items: [item('SYNCED-001')], testCaseModeEnabled: false, savedCount: 1});
  assert.equal(f.document.getElementById('manual-refresh-button').disabled, false);
  assert.equal(f.document.getElementById('home-sync-text').textContent.startsWith('Classroom API・Gmail同期済み '), true);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /Gmail新着1件/);
  assert.deepEqual(f.ids('homeRawData'), ['SYNCED-001']);
});

test('test-mode sync reports private workbook update while keeping fixture cards in view', () => {
  const f = fixture(); f.seed([item('SIM-001')]);
  f.c.manualRefreshNotifications();
  const sync = f.take('syncAndGetNotificationsForWeb');
  f.reply(sync, {items: [item('SIM-001'), item('SIM-002')], testCaseModeEnabled: true, savedCount: 3});
  assert.deepEqual(f.ids('homeRawData'), ['SIM-001', 'SIM-002']);
  assert.match(f.document.getElementById('home-sync-text').textContent, /^テスト表示更新・個人用Excel同期済み /);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /テスト表示を更新しました/);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /個人用ExcelにAPI課題0件、新着メール3件/);
});

test('a skipped sync explains the missing watermark in the result toast', () => {
  const f = fixture(); f.seed([item('SAVED-001')]);
  f.c.manualRefreshNotifications();
  const sync = f.take('syncAndGetNotificationsForWeb');
  f.reply(sync, {items: [item('SAVED-001')], testCaseModeEnabled: false, savedCount: 0,
    syncSkipped: true, syncSkipReason: '保存Excelに有効な受信日時がありません。'});
  assert.equal(f.document.getElementById('manual-refresh-button').disabled, false);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /Gmail同期を見送りました/);
  assert.match(f.document.getElementById('sync-toast-message').textContent, /有効な受信日時/);
});

test('source switch invalidates an older university-notice response', () => {
  const f = fixture();f.c.showUniversityNotices();
  const old = f.take('getUniversityNoticePayloadForWeb');
  const toggle = f.document.getElementById('test-mode-toggle');toggle.dataset.ready = 'true';
  f.c.toggleTestCaseMode(true);
  f.reply(f.take('setTestCaseModeForWeb'), {hasApiToken: true, postAuthRequired: true,
    testCaseModeEnabled: true, testSpreadsheetReady: true});
  const fresh = f.pending('getUniversityNoticePayloadForWeb').at(-1);
  f.reply(fresh, [{messageId: 'SIM-NOTICE', title: '仮想連絡', body: '', source: 'inCampus', receivedAt: '', from: '', read: false, saved: false}]);
  f.reply(old, [{messageId: 'OLD-LIVE', title: '古いデータ', body: '', source: 'inCampus', receivedAt: '', from: '', read: false, saved: false}]);
  assert.deepEqual(f.ids('universityState.items'), ['SIM-NOTICE']);
});

test('previously issued API tokens reveal no characters and cannot be copied', () => {
  const f = fixture();
  f.c.renderSecuritySettings({hasApiToken: true, tokenPreview: 'secret-prefix...secret-suffix', postAuthRequired: true,
    testCaseModeEnabled: false, testSpreadsheetReady: true});
  const token = f.document.getElementById('security-api-token');
  assert.equal(token.value, '発行済み（非表示）');
  assert.equal(token.dataset.hasFullToken, 'false');
  assert.equal(f.document.getElementById('security-token-toggle').disabled, true);
  assert.equal(f.document.getElementById('security-token-copy').disabled, true);
  f.c.toggleSecurityTokenVisibility();
  f.c.copySecurityToken();
  assert.equal(token.value, '発行済み（非表示）');
  assert.match(f.document.getElementById('security-message').textContent, /保存済みトークンはコピーできません/);
});

test('API token is shown only in the explicit one-time rotation response', () => {
  const f = fixture();
  f.c.renderSecuritySettings({hasApiToken: true, apiToken: 'one-time-token-value', tokenReturnedOnce: true,
    postAuthRequired: true, testCaseModeEnabled: false, testSpreadsheetReady: true});
  const token = f.document.getElementById('security-api-token');
  assert.equal(token.value, 'one-time-token-value');
  assert.equal(token.dataset.hasFullToken, 'true');
  assert.equal(f.document.getElementById('security-token-toggle').disabled, false);
  assert.equal(f.document.getElementById('security-token-copy').disabled, false);
  f.c.renderSecuritySettings({hasApiToken: true, apiToken: 'one-time-token-value', postAuthRequired: true,
    testCaseModeEnabled: false, testSpreadsheetReady: true});
  assert.equal(token.value, '発行済み（非表示）');
  assert.equal(token.dataset.hasFullToken, 'false');
});

test('unavailable test sheet keeps OFF and a failed toggle restores the previous setting', () => {
  const f = fixture();f.c.openSecurityModal();
  f.reply(f.take('getSecuritySettingsForWeb'), {hasApiToken: true, postAuthRequired: true, testCaseModeEnabled: false,
    testSpreadsheetReady: false, testSpreadsheetMessage: '共有設定を確認してください。'});
  const toggle = f.document.getElementById('test-mode-toggle');
  assert.equal(toggle.checked, false);assert.equal(toggle.disabled, true);
  assert.match(f.document.getElementById('test-mode-hint').textContent, /共有設定を確認/);
  toggle.dataset.ready = 'true';toggle.disabled = false;f.c.toggleTestCaseMode(true);
  f.fail(f.take('setTestCaseModeForWeb'));
  assert.equal(toggle.checked, false);
  assert.equal(f.pending('getSecuritySettingsForWeb').length, 1);
});

test('initial task cards paint before the full RPC and Home totals do not count only the preview rows',()=>{
  const first=item('first-task');first.firstPaintOnly=true;
  const payload={items:[first],partial:true,totalCount:9,cacheToken:'must-not-cache-partial',
    homeSummary:[{displayDueGroupKey:'today',displayDueGroupCount:7,displayDueGroupCourseCountsJson:'[["仮想情報演習",7]]'}]};
  const f=fixture(undefined,{holdBoot:true,initialPayload:{view:'home',payload}});
  assert.deepEqual(f.ids('notificationData.active'),['first-task']);
  assert.equal(f.read('notificationDataLoaded.active'),false);
  assert.match(f.document.getElementById('home-due-card').innerHTML,/7件/,'Home totals represent all tasks, not one preview row');
  assert.equal(f.calls.length,0,'rendering precedes all background data requests');
  f.flushAnimationFrame();assert.equal(f.calls.length,0);
  f.flushAnimationFrame();
  const full=f.take('getTaskDisplayPayloadForWeb');
  assert.equal(full.args.length,1,'the follow-up bypasses the first-card endpoint path');
  assert.equal(f.pending('cacheTaskDisplayItemsAfterWebDisplay').length,0);
  f.reply(full,{items:[item('first-task'),item('last-task')]});
  assert.deepEqual(f.ids('notificationData.active'),['first-task','last-task']);
  assert.equal(f.read('notificationDataLoaded.active'),true);
  assert.equal(f.read('homeFirstPaintSummary'),null);
});
test('a failed full task read keeps the painted cards and opening the view retries the full list',()=>{
  const f=fixture(undefined,{holdBoot:true,initialRoute:'assignment',initialPayload:{view:'assignment',
    payload:{items:[item('visible-task')],partial:true,totalCount:10}}});
  f.flushAnimationFrame();f.flushAnimationFrame();f.fail(f.take('getTaskDisplayPayloadForWeb'));
  assert.deepEqual(f.ids('notificationData.active'),['visible-task']);
  assert.match(f.document.getElementById('assignment-load-status').textContent,/残りを読み込めません/);
  f.c.loadNotifications();assert.equal(f.take('getTaskDisplayPayloadForWeb').args.length,1);
});
test('first university cards remain selected and preserve an in-flight read/save change when the full list arrives',()=>{
  const notice={messageId:'preview-notice',title:'最初のお知らせ',preview:'抜粋',source:'inCampus',receivedAt:'2099/10/01 10:00'};
  const f=fixture(undefined,{holdBoot:true,initialRoute:'university',initialPayload:{view:'university',
    payload:{items:[notice],partial:true,totalCount:89,cacheToken:'generation-1'}}});
  assert.equal(f.document.getElementById('un-list').children.length,1);
  assert.match(f.document.getElementById('un-count').textContent,/全89件中1件/);
  assert.equal(f.calls.length,0);f.flushAnimationFrame();f.flushAnimationFrame();
  const full=f.take('getUniversityNoticePayloadForWeb');
  vm.runInContext("universityState.selected='preview-notice';updateUniversityNotice(universityState.items[0],{read:true})",f.c);
  const stateWrite=f.take('setUniversityNoticeState');
  f.reply(full,{items:[notice,{...notice,messageId:'last-notice'}],cacheToken:'generation-1'});
  assert.equal(f.read('universityState.selected'),'preview-notice');
  assert.equal(f.read('universityState.items[0].read'),true,'the full read cannot undo a pending user action');
  assert.equal(f.read('universityState.partial'),false);
  f.reply(stateWrite,true);assert.equal(f.read('universityState.items[0].pending'),false);
});
test('a failed full university read keeps the first notice and allows a complete-list retry',()=>{
  const notice={messageId:'first',title:'保存された最初の通知',source:'inCampus'};
  const f=fixture(undefined,{holdBoot:true,initialRoute:'university',initialPayload:{view:'university',
    payload:{items:[notice],partial:true,totalCount:20}}});
  f.flushAnimationFrame();f.flushAnimationFrame();f.fail(f.take('getUniversityNoticePayloadForWeb'));
  assert.equal(f.read('universityState.items[0].messageId'),'first');
  assert.match(f.document.getElementById('un-status').textContent,/残りを読み込めません/);
  f.c.showUniversityNotices();assert.equal(f.take('getUniversityNoticePayloadForWeb').args.length,1);
});
test('initial read-only RPC requests prefer the saved first cards; full follow-ups and completion reads do not',()=>{
  const task=fixture(undefined,{holdBoot:true,initialRoute:'assignment'});
  assert.deepEqual(task.take('getTaskDisplayPayloadForWeb').args,['未完了',null,true]);
  const university=fixture(undefined,{holdBoot:true,initialRoute:'university'});
  assert.deepEqual(university.take('getUniversityNoticePayloadForWeb').args,[false,null,true]);
  task.c.loadCompletedNotifications();assert.deepEqual(task.take('getTaskDisplayPayloadForWeb','完了').args,['完了']);
});
function homePrefetchFixture(partial = false) {
  return fixture(undefined, {holdBoot:true,initialPayload:{view:'home',payload:{
    items:[item('HOME-SHARED-TASK')],partial,totalCount:4,cacheToken:'',
    homeSummary:partial ? [{displayDueGroupKey:'today',displayDueGroupCount:4,
      displayDueGroupCourseCountsJson:'[["仮想情報演習",4]]'}] : undefined
  }}});
}
const prefetchedNotice = {messageId:'HOME-PREFETCH-NOTICE',title:'先読みする仮想お知らせ',
  source:'inCampus',preview:'架空の抜粋',receivedAt:'2026/10/09 10:00',read:false,saved:false};

test('Home paints before parallel task and notice reads; assignment navigation shares its pending full task read',()=>{
  const f=homePrefetchFixture(true);
  assert.equal(f.read('currentScreen'),'home');assert.equal(f.calls.length,0);
  f.flushAnimationFrame();assert.equal(f.calls.length,0);
  f.flushAnimationFrame();
  const task=f.take('getTaskDisplayPayloadForWeb'),notice=f.take('getUniversityNoticePayloadForWeb');
  assert.deepEqual(task.args,['未完了']);assert.deepEqual(notice.args,[false]);
  assert.deepEqual(f.calls.map(c=>c.method).sort(),['getTaskDisplayPayloadForWeb','getUniversityNoticePayloadForWeb']);
  f.c.loadNotifications();
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length,1,'the assignment view reuses the active Home read');
  f.reply(notice,{items:[prefetchedNotice],cacheToken:'notice-generation'});
  assert.equal(f.read('currentScreen'),'active','the hidden notice response cannot navigate');
  assert.equal(f.pending('getUniversityNoticeBodyForWeb').length,0);
  f.reply(task,{items:[item('HOME-SHARED-TASK'),item('SECOND-TASK')],cacheToken:''});
  assert.deepEqual(f.ids('currentRawData'),['HOME-SHARED-TASK','SECOND-TASK']);
});
test('fresh Home-prefetched notices are already rendered and first navigation sends no duplicate list read',()=>{
  const f=homePrefetchFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  f.reply(f.take('getUniversityNoticePayloadForWeb'),{items:[prefetchedNotice],cacheToken:'notice-generation'});
  assert.equal(f.read('currentScreen'),'home');
  assert.equal(f.document.getElementById('un-list').children.length,1);
  f.flushAnimationFrame();f.flushAnimationFrame();
  assert.equal(f.read("firstContentMarkedViews.has('university')"),false,'hidden preparation is not a visible-card timestamp');
  const count=f.calls.length;f.c.showUniversityNotices();
  assert.equal(f.calls.length,count,'the first visit uses the fresh prepared list');
  assert.equal(f.read('currentScreen'),'university');
  f.flushAnimationFrame();f.flushAnimationFrame();
  assert.equal(f.read("firstContentMarkedViews.has('university')"),true);
});
test('entering notices during Home prefetch keeps exactly one read and its reply does not switch the page',()=>{
  const f=homePrefetchFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  const read=f.take('getUniversityNoticePayloadForWeb');f.c.showUniversityNotices();
  assert.equal(f.pending('getUniversityNoticePayloadForWeb').length,1);
  f.reply(read,{items:[prefetchedNotice],cacheToken:'notice-generation'});
  assert.equal(f.read('currentScreen'),'university');assert.equal(f.read('universityState.loaded'),true);
  assert.equal(f.document.getElementById('un-list').children.length,1);
});
test('failed hidden prefetch leaves Home intact and entering notices retries; a queued prefetch is cancelled on navigation',()=>{
  const f=homePrefetchFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  const label=f.document.getElementById('home-sync-text').textContent;
  f.fail(f.take('getUniversityNoticePayloadForWeb'));
  assert.equal(f.read('currentScreen'),'home');assert.equal(f.document.getElementById('home-sync-text').textContent,label);
  f.c.showUniversityNotices();assert.equal(f.pending('getUniversityNoticePayloadForWeb').length,1);
  const early=homePrefetchFixture();early.c.showUniversityNotices();
  early.flushAnimationFrame();early.flushAnimationFrame();
  assert.equal(early.pending('getUniversityNoticePayloadForWeb').length,1,'navigating before paint cannot add a second notice read');
  assert.equal(early.read("firstContentMarkedViews.has('home')"),false,'a cancelled Home paint is not reported as visible');
});
test('source and virtual-date changes discard old notice prefetch replies and regenerate both views from the selected source',()=>{
  const f=homePrefetchFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  const old=f.take('getUniversityNoticePayloadForWeb');
  f.c.applyTestCaseClockState({testCaseModeEnabled:true,testCaseClockDateTime:'2026-12-31T23:58'});
  f.reply(old,{items:[prefetchedNotice],testCaseClockState:{testCaseModeEnabled:false}});
  assert.equal(f.read('testCaseModeEnabled'),true);assert.deepEqual(f.ids('universityState.items'),[]);
  f.reply(f.take('getTaskDisplayPayloadForWeb'),{items:[item('SIM-TASK')],cacheToken:'',
    testCaseClockState:{testCaseModeEnabled:true,testCaseClockDateTime:'2026-12-31T23:58'}});
  f.flushAnimationFrame();f.flushAnimationFrame();
  f.reply(f.take('getUniversityNoticePayloadForWeb'),{items:[{...prefetchedNotice,messageId:'SIM-NOTICE'}]});
  assert.deepEqual(f.ids('universityState.items'),['SIM-NOTICE']);
  assert.equal(f.read('currentScreen'),'home');
});
test('expired prefetch and an explicit sync force a fresh notice read instead of trusting the earlier snapshot',()=>{
  const f=homePrefetchFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  f.reply(f.take('getUniversityNoticePayloadForWeb'),{items:[prefetchedNotice]});
  vm.runInContext('universityState.prefetchedAt = Date.now() - AUTO_REFRESH_INTERVAL - 1',f.c);
  f.c.showUniversityNotices();assert.equal(f.pending('getUniversityNoticePayloadForWeb').length,1);
  const synced=homePrefetchFixture();synced.flushAnimationFrame();synced.flushAnimationFrame();
  synced.reply(synced.take('getUniversityNoticePayloadForWeb'),{items:[prefetchedNotice]});
  synced.c.manualRefreshNotifications();
  synced.reply(synced.take('syncAndGetNotificationsForWeb'),{items:[item('AFTER-SYNC')],apiSuccess:true,gmailSuccess:true});
  synced.c.showUniversityNotices();assert.equal(synced.pending('getUniversityNoticePayloadForWeb').length,1);
});
test('a pre-sync notice prefetch cannot be accepted after manual sync completes',()=>{
  const f=homePrefetchFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  const old=f.take('getUniversityNoticePayloadForWeb');
  f.c.manualRefreshNotifications();
  f.reply(f.take('syncAndGetNotificationsForWeb'),{items:[item('NEW-TASK')],apiSuccess:true,gmailSuccess:true});
  f.reply(old,{items:[prefetchedNotice]});
  assert.deepEqual(f.ids('universityState.items'),[]);
  f.flushAnimationFrame();f.flushAnimationFrame();
  f.reply(f.take('getUniversityNoticePayloadForWeb'),{items:[{...prefetchedNotice,messageId:'POST-SYNC-NOTICE'}]});
  assert.deepEqual(f.ids('universityState.items'),['POST-SYNC-NOTICE']);
});
function simultaneousHomePreviewFixture() {
  return fixture(undefined,{holdBoot:true,initialPayload:{view:'home',payload:{
    items:[item('STARTUP-TASK')],partial:true,totalCount:4,
    homeSummary:[{displayDueGroupKey:'today',displayDueGroupCount:4,displayDueGroupCourseCountsJson:'[["仮想情報演習",4]]'}]
  },universityPayload:{items:[prefetchedNotice],partial:true,totalCount:89,cacheToken:'startup-generation'}}});
}
test('Home and notice previews are ready before any full-list RPC; immediate navigation keeps one pending read',()=>{
  const f=simultaneousHomePreviewFixture();
  assert.equal(f.read('currentScreen'),'home');assert.equal(f.calls.length,0);
  assert.deepEqual(f.ids('notificationData.active'),['STARTUP-TASK']);
  assert.deepEqual(f.ids('universityState.items'),['HOME-PREFETCH-NOTICE']);
  assert.equal(f.document.getElementById('un-list').children.length,1);
  f.flushAnimationFrame();f.flushAnimationFrame();
  const task=f.take('getTaskDisplayPayloadForWeb'),notice=f.take('getUniversityNoticePayloadForWeb');
  assert.equal(f.pending('getUniversityNoticePayloadForWeb').length,1);
  assert.equal(f.read("firstContentMarkedViews.has('university')"),false);
  f.document.getElementById('bottom-university-button').onclick({type:'click'});
  assert.equal(f.document.getElementById('un-list').children.length,1,'first notice stays visible while its full read is pending');
  assert.equal(f.read('currentScreen'),'university');
  assert.equal(f.pending('getUniversityNoticePayloadForWeb').length,1);
  f.flushAnimationFrame();f.flushAnimationFrame();
  assert.equal(f.read("firstContentMarkedViews.has('university')"),true);
  f.document.getElementById('bottom-assignment-button').onclick({type:'click'});
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length,1);
  assert.deepEqual(f.ids('currentRawData'),['STARTUP-TASK']);
  f.reply(task,{items:[item('STARTUP-TASK'),item('FULL-TASK')]});
  f.reply(notice,{items:[prefetchedNotice,{...prefetchedNotice,messageId:'FULL-NOTICE'}],cacheToken:'startup-generation'});
  assert.equal(f.read('currentScreen'),'active');
  assert.equal(f.pending('getUniversityNoticeBodyForWeb').length,0);
  assert.equal(f.calls.some(call=>/sync|bootstrap|MailsToSheet/.test(call.method)),false);
});
test('bottom navigation never interprets the click event as an embedded assignment payload',()=>{
  const f=fixture();f.c.setNotificationData([item('ALREADY-READ')],'active');
  f.document.getElementById('bottom-assignment-button').onclick({type:'click',target:{id:'bottom-assignment-button'}});
  assert.equal(f.pending('getTaskDisplayPayloadForWeb').length,1);
  assert.equal(f.pending('getNotificationsForWeb').length,0,'a click event must not trigger a compatibility fallback');
  assert.deepEqual(f.ids('currentRawData'),['ALREADY-READ']);
});
test('changing the source removes hidden startup previews and rejects their pending full-list replies',()=>{
  const f=simultaneousHomePreviewFixture();f.flushAnimationFrame();f.flushAnimationFrame();
  const oldTask=f.take('getTaskDisplayPayloadForWeb'),oldNotice=f.take('getUniversityNoticePayloadForWeb');
  f.c.applyTestCaseClockState({testCaseModeEnabled:true,testCaseClockDateTime:'2026-12-31T23:58'});
  assert.equal(f.document.getElementById('un-list').children.length,0);
  f.c.showUniversityNotices();
  assert.equal(f.document.getElementById('un-list').children.length,0,'old live cards cannot reappear in the virtual-date view');
  f.reply(oldNotice,{items:[prefetchedNotice]});f.reply(oldTask,{items:[item('OLD-REAL-TASK')]});
  assert.deepEqual(f.ids('universityState.items'),[]);assert.deepEqual(f.ids('notificationData.active'),[]);
});
console.log(`${passed} UI regression tests passed.`);
