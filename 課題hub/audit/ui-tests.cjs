// Offline regression tests for the real browser scripts. No Google connection.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {matrixCases, boundaryCases} = require('./deadline-cases.cjs');
const sourceDir = path.resolve(__dirname, '../taskhub-split/taskhub-split');

function element() {
  const classes = new Set();
  return {
    children: [], style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    classList: {
      add(...names) {names.forEach(name => classes.add(name));},
      remove(...names) {names.forEach(name => classes.delete(name));},
      contains(name) {return classes.has(name);},
      toggle(name, value) {value = value === undefined ? !classes.has(name) : value;
        if (value) classes.add(name); else classes.delete(name); return value;}
    },
    setAttribute(name, value) {this[name] = value;},
    append(...children) {this.children.push(...children);},
    appendChild(child) {this.children.push(child);},
    replaceChildren(...children) {this.children = children;},
    addEventListener() {}
  };
}

function fixture(fixedNow, {holdBoot = false, initialRoute = 'home'} = {}) {
  const calls = [], alerts = [], nodes = new Map(), timers = [];
  let reloadCount = 0;
  const document = {
    getElementById(id) {if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id);},
    querySelectorAll() {return [];}, createElement: element
  };
  const routeParameter = initialRoute === 'home' ? {} : {view: initialRoute};
  const script = {url: {getLocation(callback) {if (typeof callback === 'function') callback({parameter: routeParameter});}}};
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
    google: {script}, console: {error() {}}, alert: message => alerts.push(message),
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
    const boot = calls.find(call => call.method === 'getNotificationsForWeb' || call.method === 'getUniversityNoticesForWeb');
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
    flushTimers() {while (timers.length) timers.shift()();}, get reloadCount() {return reloadCount;}};
}

function item(id, done = false) {
  return {messageId: id, title: id, courseName: '仮想情報演習', source: 'inCampus',
    status: done ? '完了' : '未確認', dueType: 'unknown'};
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

test('initial deep links request only the matching page data', () => {
  const university = fixture(undefined, {holdBoot: true, initialRoute: 'university'});
  assert.equal(university.pending('getUniversityNoticesForWeb').length, 1);
  assert.equal(university.pending('getNotificationsForWeb').length, 0);
  assert.equal(university.pending('getCompletedNotificationsForWeb').length, 0);

  const assignment = fixture(undefined, {holdBoot: true, initialRoute: 'assignment'});
  assert.equal(assignment.pending('getNotificationsForWeb').length, 1);
  assert.equal(assignment.pending('getUniversityNoticesForWeb').length, 0);

  const home = fixture(undefined, {holdBoot: true});
  assert.equal(home.pending('getNotificationsForWeb').length, 1);
  assert.equal(home.pending('getUniversityNoticesForWeb').length, 0);
});

test('navigating to each page calls only its matching list endpoint', () => {
  const f = fixture();
  const start = f.calls.length;
  f.c.showUniversityNotices();
  assert.deepEqual(f.calls.slice(start).map(call => call.method), ['getUniversityNoticesForWeb']);
  const afterUniversity = f.calls.length;
  f.c.loadNotifications();
  assert.deepEqual(f.calls.slice(afterUniversity).map(call => call.method), ['getNotificationsForWeb']);
  const afterAssignments = f.calls.length;
  f.c.loadCompletedNotifications();
  assert.deepEqual(f.calls.slice(afterAssignments).map(call => call.method), ['getCompletedNotificationsForWeb']);
});

test('assignment navigation reuses an in-flight home read instead of starting a duplicate', () => {
  const f = fixture(undefined, {holdBoot: true});
  const boot = f.take('getNotificationsForWeb');
  f.c.loadNotifications();
  assert.equal(f.pending('getNotificationsForWeb').length, 1);
  assert.equal(f.document.getElementById('list').textContent, '読み込み中...');
  f.reply(boot, [item('one-read')]);
  assert.deepEqual(f.ids('currentRawData'), ['one-read']);
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
  assert.ok(f.pending('getCompletedNotificationsForWeb').length);

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
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getNotificationsForWeb');
  f.c.loadNotifications();
  f.c.loadCompletedNotifications(); const completed = f.take('getCompletedNotificationsForWeb');
  f.reply(completed, [item('done', true)]); f.reply(boot, [item('active')]);
  assert.equal(f.read('currentScreen'), 'completed');
  assert.equal(f.read('currentViewMode'), 'completed');
  assert.deepEqual(f.ids('currentRawData'), ['done']);
  assert.deepEqual(f.ids('homeRawData'), ['active']);
});

test('newest refresh wins over boot read and prior list request', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getNotificationsForWeb');
  f.c.loadNotifications();
  f.c.manualRefreshNotifications();
  const fresh = f.pending('syncAndGetNotificationsForWeb').at(-1);
  f.reply(fresh, {items: [item('new')], testCaseModeEnabled: false, savedCount: 1}); f.reply(boot, [item('boot')]);
  assert.deepEqual(f.ids('currentRawData'), ['new']); assert.deepEqual(f.ids('homeRawData'), ['new']);
});

test('an in-flight completed read is reused after navigating away and back', () => {
  const f = fixture();
  f.c.loadCompletedNotifications(); const old = f.take('getCompletedNotificationsForWeb');
  f.c.loadNotifications(); const active = f.take('getNotificationsForWeb');
  f.c.loadCompletedNotifications();
  assert.equal(f.pending('getCompletedNotificationsForWeb').length, 1);
  f.reply(active, [item('active')]); f.reply(old, [item('done', true)]);
  assert.deepEqual(f.ids('currentRawData'), ['done']); assert.equal(f.read('currentViewMode'), 'completed');
});

test('a background active response preserves the completed loading indicator', () => {
  const f = fixture(); f.c.loadNotifications(); const active = f.take('getNotificationsForWeb');
  f.c.loadCompletedNotifications();
  f.reply(active, [item('active')]);
  assert.equal(f.document.getElementById('list').textContent, '完了済み一覧を読み込み中...');
  assert.deepEqual(f.ids('homeRawData'), ['active']);
});

test('home and university navigation survive background assignment responses', () => {
  const f = fixture();
  f.c.loadNotifications(); const active = f.take('getNotificationsForWeb');
  f.c.loadCompletedNotifications(); const completed = f.take('getCompletedNotificationsForWeb');
  f.c.showHomeView(); f.reply(completed, [item('done', true)]);
  assert.equal(f.read('currentViewMode'), 'active'); assert.equal(f.read('currentScreen'), 'home');
  f.c.showUniversityNotices(); const university = f.take('getUniversityNoticesForWeb');
  f.reply(active, [item('active')]); f.reply(university, []);
  assert.equal(f.read('currentScreen'), 'university');
  assert.ok(f.document.getElementById('university-view').classList.contains('is-active'));
  f.c.showHomeView(); assert.deepEqual(f.ids('homeRawData'), ['active']);
});

test('stale failures cannot replace newer data or another screen with an error', () => {
  const f = fixture(); f.c.loadNotifications(); const old = f.take('getNotificationsForWeb');
  f.c.manualRefreshNotifications(); const fresh = f.pending('syncAndGetNotificationsForWeb').at(-1);
  f.reply(fresh, {items: [item('new')], testCaseModeEnabled: false, savedCount: 1}); f.fail(old);
  assert.deepEqual(f.ids('currentRawData'), ['new']);
  assert.ok(!f.document.getElementById('list').textContent.includes('エラー'));
  f.c.loadNotifications(); const active = f.take('getNotificationsForWeb');
  f.c.loadCompletedNotifications(); f.fail(active);
  assert.equal(f.document.getElementById('list').textContent, '完了済み一覧を読み込み中...');
  f.fail(f.take('getCompletedNotificationsForWeb'));
  assert.match(f.document.getElementById('list').textContent, /エラー.*offline/);
});

test('done immediately updates the home count and stale reads cannot resurrect it', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.refreshNotifications(); const before = f.pending('getNotificationsForWeb').at(-1);
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
  assert.equal(f.pending('getNotificationsForWeb').length, 1);
  assert.equal(f.pending('getCompletedNotificationsForWeb').length, 1);
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
  f.reply(f.take('getCompletedNotificationsForWeb'), [item('A', true)]);
  f.reply(f.take('getNotificationsForWeb'), []);
  assert.equal(f.read('currentScreen'), 'university');
  f.c.showAssignmentView('completed'); f.c.markAsUndone('A'); f.c.showHomeView();
  f.reply(f.take('markNotificationUndone', 'A'));
  f.reply(f.take('getNotificationsForWeb'), [item('A')]);
  f.reply(f.take('getCompletedNotificationsForWeb'), []);
  assert.equal(f.read('currentScreen'), 'home'); assert.equal(f.read('currentViewMode'), 'active');
  assert.deepEqual(f.ids('homeRawData'), ['A']);
});

test('failed done rolls back locally and retries reads without navigating', () => {
  const f = fixture(); f.seed([item('A')]);
  f.c.markAsDone('A'); f.c.showHomeView(); f.fail(f.take('markNotificationDone', 'A'));
  assert.deepEqual(f.ids('homeRawData'), ['A']); assert.equal(f.read('currentScreen'), 'home');
  assert.equal(f.read('notificationStatusChanges.size'), 0); assert.equal(f.alerts.length, 1);
  assert.equal(f.read('lastUndoMessageId'), '');
  assert.equal(f.pending('getNotificationsForWeb').length, 1);
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

test('weekday test clock renders today, tomorrow, this week and next week as separate groups', () => {
  const fixedNow = new Date(2026, 9, 8, 10, 30).getTime();
  const f = fixture(fixedNow);
  const rows = [
    {messageId: 'expired', dueType: 'detected', dueDateKey: '2026-10-07', dueTime: '23:59'},
    {messageId: 'today', dueType: 'detected', dueDateKey: '2026-10-08', dueTime: '23:59'},
    {messageId: 'tomorrow', dueType: 'detected', dueDateKey: '2026-10-09', dueTime: '23:59'},
    {messageId: 'this-week', dueType: 'detected', dueDateKey: '2026-10-11', dueTime: '23:59'},
    {messageId: 'next-week', dueType: 'detected', dueDateKey: '2026-10-18', dueTime: '23:59'},
    {messageId: 'no-deadline', dueType: 'none', dueDateKey: ''},
    {messageId: 'unknown-date', dueType: 'unknown', dueDateKey: ''}
  ];
  const grouped = JSON.parse(JSON.stringify(f.c.groupNotificationsByDue(rows)));
  const assigned = Object.fromEntries(grouped.flatMap(group => group.items.map(item => [item.messageId, group.key])));
  assert.deepEqual(assigned, {
    expired: 'expired', today: 'today', tomorrow: 'tomorrow', 'this-week': 'thisWeek',
    'next-week': 'later', 'no-deadline': 'none', 'unknown-date': 'unknown'
  });
});

test('63 weekday/date-offset combinations follow today, tomorrow, Sunday-ending week and later boundaries', () => {
  const byViewDate = new Map();
  for (const testCase of matrixCases) {
    if (!byViewDate.has(testCase.viewDate)) byViewDate.set(testCase.viewDate, []);
    byViewDate.get(testCase.viewDate).push(testCase);
  }
  for (const cases of byViewDate.values()) {
    const f = fixture(cases[0].viewAt);
    const rows = cases.map(testCase => ({messageId: testCase.id, dueType: testCase.dueType,
      dueDateKey: testCase.dueDateKey, dueTime: testCase.dueTime}));
    const grouped = JSON.parse(JSON.stringify(f.c.groupNotificationsByDue(rows)));
    const assigned = grouped.flatMap(group => group.items.map(item => [item.messageId, group.key]));
    assert.equal(assigned.length, cases.length, `Each deadline must occur in exactly one group on ${cases[0].viewDate}`);
    const actual = Object.fromEntries(assigned);
    for (const testCase of cases) assert.equal(actual[testCase.id], testCase.expectedGroup, testCase.id);
  }
});

test('deadline minute, midnight normalization, calendar rollover and invalid inputs match the shared case table', () => {
  for (const testCase of boundaryCases) {
    const f = fixture(testCase.viewAt);
    const row = {messageId: testCase.id, dueType: testCase.dueType,
      dueDateKey: testCase.dueDateKey, dueTime: testCase.dueTime};
    const grouped = JSON.parse(JSON.stringify(f.c.groupNotificationsByDue([row])));
    const assigned = grouped.flatMap(group => group.items.map(item => [item.messageId, group.key]));
    assert.deepEqual(assigned, [[testCase.id, testCase.expectedGroup]], testCase.id);
  }
});

test('selected JST test clock drives deadline groups only while test mode is ON', () => {
  const f = fixture(Date.parse('2026-10-08T10:30:00+09:00'));
  f.c.applyTestCaseClockState({testCaseModeEnabled: true, testCaseClockDateTime: '2026-12-31T23:58', testCaseClockPresets: []});
  const rows = [
    {messageId: 'year-end-today', dueType: 'detected', dueDateKey: '2026-12-31', dueTime: '23:59'},
    {messageId: 'new-year-tomorrow', dueType: 'detected', dueDateKey: '2027-01-01', dueTime: ''},
    {messageId: 'sunday-this-week', dueType: 'detected', dueDateKey: '2027-01-03', dueTime: '23:59'},
    {messageId: 'monday-next-week', dueType: 'detected', dueDateKey: '2027-01-04', dueTime: '23:59'}
  ];
  const assignedFor = () => Object.fromEntries(f.c.groupNotificationsByDue(rows)
    .flatMap(group => group.items.map(item => [item.messageId, group.key])));
  assert.deepEqual(assignedFor(), {
    'year-end-today': 'today', 'new-year-tomorrow': 'tomorrow',
    'sunday-this-week': 'thisWeek', 'monday-next-week': 'later'
  });
  f.c.applyTestCaseClockState({testCaseModeEnabled: false, testCaseClockDateTime: '2026-12-31T23:58', testCaseClockPresets: []});
  assert.equal(assignedFor()['year-end-today'], 'later');
});

test('items in one group are ordered by deadline time without moving groups', () => {
  const f = fixture(Date.parse('2026-10-08T08:00:00+09:00'));
  const rows = [
    {messageId: 'late', dueType: 'detected', dueDateKey: '2026-10-08', dueTime: '23:59'},
    {messageId: 'early', dueType: 'detected', dueDateKey: '2026-10-08', dueTime: '09:00'},
    {messageId: 'middle', dueType: 'detected', dueDateKey: '2026-10-08', dueTime: '12:30'},
  ];
  const grouped = JSON.parse(JSON.stringify(f.c.groupNotificationsByDue(rows)));
  assert.deepEqual(grouped.find(group => group.key === 'today').items.map(item => item.messageId),
    ['early', 'middle', 'late']);
});

test('settings switch data sources in place, read the selected source, and do not start mail sync', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getNotificationsForWeb');f.c.openSecurityModal();
  f.reply(f.take('getSecuritySettingsForWeb'), {hasApiToken: true, tokenPreview: '••••', postAuthRequired: true,
    testCaseModeEnabled: false, testSpreadsheetReady: true});
  const toggle = f.document.getElementById('test-mode-toggle');
  assert.equal(toggle.checked, false);assert.equal(toggle.disabled, false);
  assert.match(f.document.getElementById('test-mode-hint').textContent, /固定テストシート/);
  assert.match(f.document.getElementById('test-mode-hint').textContent, /保存先は元の個人Excel/);
  f.c.toggleTestCaseMode(true);assert.deepEqual(f.take('setTestCaseModeForWeb').args, [true]);
  f.reply(f.take('setTestCaseModeForWeb'), {hasApiToken: true, tokenPreview: '••••', postAuthRequired: true,
    testCaseModeEnabled: true, testSpreadsheetReady: true});
  const selectedSourceRead = f.pending('getNotificationsForWeb').at(-1);
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
  assert.ok(f.pending('getNotificationsForWeb').length > 0);
  assert.equal(f.pending('refreshAndGetNotificationsForWeb').length, 0);
  f.c.renderTestCaseModeSettings({testCaseModeEnabled: false, testSpreadsheetReady: true});
  assert.equal(f.document.getElementById('header-test-clock-button').hidden, true);
  assert.equal(f.document.getElementById('header-test-clock-current').textContent, '設定中：2028/02/29 09:00（日本時間）');
});

test('OFF switch returns to saved data with a read-only request, not a Gmail refresh', () => {
  const f = fixture(undefined, {holdBoot: true}), boot = f.take('getNotificationsForWeb');f.c.openSecurityModal();
  f.reply(f.take('getSecuritySettingsForWeb'), {hasApiToken: true, postAuthRequired: true,
    testCaseModeEnabled: true, testSpreadsheetReady: true});
  const toggle = f.document.getElementById('test-mode-toggle');toggle.checked = true;
  f.c.toggleTestCaseMode(false);
  f.reply(f.take('setTestCaseModeForWeb'), {hasApiToken: true, postAuthRequired: true,
    testCaseModeEnabled: false, testSpreadsheetReady: true});
  const savedRead = f.pending('getNotificationsForWeb').at(-1);
  f.reply(savedRead, [item('SAVED-001')]);
  f.reply(boot, [item('OLD-TEST')]);
  assert.equal(toggle.checked, false);
  assert.match(f.document.getElementById('security-message').textContent, /保存済みデータへ切り替えました/);
  assert.equal(f.calls.filter(call => call.method === 'refreshAndGetNotificationsForWeb').length, 0);
  assert.equal(f.reloadCount, 0);
});

test('startup and 15-minute polling read stored rows; explicit update performs API then Gmail sync', () => {
  const f = fixture(undefined, {holdBoot: true});
  const boot = f.take('getNotificationsForWeb');
  assert.equal(f.pending('refreshAndGetNotificationsForWeb').length, 0);
  f.reply(boot, [item('SAVED-001')]);

  f.c.refreshNotifications();
  const polling = f.pending('getNotificationsForWeb').at(-1);
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
  const old = f.take('getUniversityNoticesForWeb');
  const toggle = f.document.getElementById('test-mode-toggle');toggle.dataset.ready = 'true';
  f.c.toggleTestCaseMode(true);
  f.reply(f.take('setTestCaseModeForWeb'), {hasApiToken: true, postAuthRequired: true,
    testCaseModeEnabled: true, testSpreadsheetReady: true});
  const fresh = f.pending('getUniversityNoticesForWeb').at(-1);
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

console.log(`${passed} UI regression tests passed.`);
