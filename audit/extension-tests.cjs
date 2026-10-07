// Offline regression checks. All Chrome, DOM, network and clock APIs are mocks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..', 'taskhub-extension-v2.5');
const source = name => fs.readFileSync(path.join(base, name), 'utf8');
const tests = [];
function test(name, fn) { tests.push({name, fn}); }
function storage(initial = {}) {
  const values = {...initial};
  return {values, async get(keys) {
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]]));
  }, async set(update) { Object.assign(values, update); }};
}
function record(i, extra = {}) {
  return {title: `課題${i}`, courseName: '授業', classroomUrl: `https://classroom.google.com/c/COURSE/a/ITEM${i}/details`, ...extra};
}
function background(initial = {}, responder) {
  const local = storage({webAppUrl: 'https://script.google.com/macros/s/TEST/exec', apiToken: 'a'.repeat(64), ...initial});
  const posts = [];
  let listener;
  const c = vm.createContext({URL, AbortController, console, Date,
    setTimeout: () => 1, clearTimeout() {},
    chrome: {storage: {local}, runtime: {onMessage: {addListener(fn) {listener = fn;}}}},
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      posts.push({url, body, raw: options.body});
      const result = responder ? await responder(body, posts.length, local) : {
        ok: true, results: body.records.map(item => ({...item, matched: true}))
      };
      return {ok: true, status: 200, text: async () => JSON.stringify(result)};
    }
  });
  vm.runInContext(source('background.js'), c);
  return {c, local, posts, message: message => new Promise(resolve => listener(message, {}, resolve))};
}
function content(initial = {}) {
  let now = 100000;
  class MockDate extends Date { static now() { return now; } }
  const local = storage(initial);
  const location = new URL('https://classroom.google.com/a/turned-in/all');
  const document = {URL: location.href, readyState: 'complete', body: {textContent: ''}, querySelector: () => null, querySelectorAll: () => []};
  const c = vm.createContext({URL, console, Date: MockDate, location, document,
    window: {__taskhubAutoSyncWatcherInstalled: true, setTimeout(fn, ms) { now += ms; fn(); }, clearTimeout() {}},
    chrome: {storage: {local}, runtime: {onMessage: {addListener() {}}, sendMessage: async () => ({ok: true})}}
  });
  vm.runInContext(source('content.js'), c);
  c.showInCampusSyncDebug = () => {};
  c.saveSyncStatus = async status => { c.saved = status; };
  return {c, local, document, advance(ms) {now += ms;}};
}

test('all extension scripts parse', () => {
  for (const file of ['background.js', 'content.js', 'popup.js']) new vm.Script(source(file), {filename: file});
});
test('201 Classroom records are posted as 100/100/1, all results retained', async () => {
  const {c, posts} = background();
  const result = await c.postClassroomCompletionRecordsToHub(Array.from({length: 201}, (_, i) => record(i)));
  assert.deepEqual(posts.map(p => p.body.records.length), [100, 100, 1]);
  assert.equal(result.ok, true); assert.equal(result.matchedCount, 201); assert.equal(result.sentCount, 201);
  assert.equal(result.results[200].recordIndex, 200);
});
test('body length including authentication splits below 190000 characters', async () => {
  const {c, posts} = background();
  const result = await c.postClassroomDueTimeRecordsToHub(Array.from({length: 6}, (_, i) => record(i, {dueText: '日'.repeat(90000)})));
  assert.equal(result.ok, true); assert.equal(result.matchedCount, 6);
  assert.equal(posts.length, 3); assert(posts.every(p => p.raw.length <= 190000));
});
test('one oversized record fails alone while later records succeed', async () => {
  const {c, posts} = background();
  const result = await c.postClassroomCompletionRecordsToHub([record(0), record(1, {title: 'x'.repeat(200000)}), record(2)]);
  assert.equal(posts.length, 1); assert.equal(result.ok, false); assert.equal(result.failedCount, 1);
  assert.equal(result.results.length, 3); assert.equal(result.results[1].failed, true); assert.equal(result.matchedCount, 2);
});
test('failure in middle batch keeps per-item failure and later successes', async () => {
  const {c, posts} = background({}, (body, index) => {
    if (index === 2) throw new Error('offline');
    return {ok: true, results: body.records.map(item => ({...item, matched: true}))};
  });
  const result = await c.postClassroomCompletionRecordsToHub(Array.from({length: 201}, (_, i) => record(i)));
  assert.equal(posts.length, 3); assert.equal(result.ok, false); assert.equal(result.sentCount, 101);
  assert.equal(result.failedCount, 100); assert.equal(result.results[100].failed, true);
  assert.equal(result.results[200].matched, true); assert.equal(result.unmatchedCount, 0);
});
test('unmatched server result stays distinct from a transport failure', async () => {
  const {c} = background({}, body => ({ok: true, results: body.records.map(item => ({...item, matched: false, reason: '対象なし'}))}));
  const result = await c.postClassroomCompletionRecordsToHub([record(0)]);
  assert.equal(result.ok, true); assert.equal(result.unmatchedCount, 1); assert.equal(result.failedCount, 0);
});
test('incomplete response is not reported as synchronized', async () => {
  const {c} = background({}, () => ({ok: true, results: []}));
  const result = await c.postClassroomCompletionRecordsToHub([record(0)]);
  assert.equal(result.ok, false); assert.equal(result.results[0].failed, true);
});
test('empty extraction does not POST or initialize server storage', async () => {
  const {c, posts} = background();
  const result = await c.postClassroomCompletionRecordsToHub([]);
  assert.equal(result.ok, true); assert.equal(posts.length, 0);
});
test('preview guards all three POST messages even without valid connection settings', async () => {
  const {message, posts} = background({previewOnly: true, webAppUrl: '', apiToken: ''});
  for (const type of ['POST_INCAMPUS_ASSIGNMENT', 'POST_CLASSROOM_COMPLETION_RECORDS', 'POST_CLASSROOM_DUE_TIME_RECORDS']) {
    const result = await message({type, assignment: {title: '課題'}, records: [record(0)]});
    assert.equal(result.ok, true); assert.equal(result.result.dryRun, true);
  }
  assert.equal(posts.length, 0);
});
test('turning preview on during batching stops remaining requests', async () => {
  const {c, posts} = background({}, (body, index, local) => {
    if (index === 1) local.values.previewOnly = true;
    return {ok: true, results: body.records.map(item => ({...item, matched: true}))};
  });
  const result = await c.postClassroomCompletionRecordsToHub(Array.from({length: 201}, (_, i) => record(i)));
  assert.equal(posts.length, 1); assert.equal(result.sentCount, 100); assert.equal(result.previewCount, 101);
  assert.equal(result.previewOnly, true); assert.equal(result.results[200].preview, true);
});
test('missing connection is exposed as a failed message', async () => {
  const {message} = background({webAppUrl: ''});
  const result = await message({type: 'POST_INCAMPUS_ASSIGNMENT', assignment: {title: '課題'}});
  assert.equal(result.ok, false); assert(result.error);
});
test('automatic Classroom sync respects stored preview and does not advance timestamp', async () => {
  const {c, local} = content({previewOnly: true});
  c.collectClassroomRecordsFromDocument = async () => ({ok: true, records: [record(0)], expandedSectionCount: 0});
  c.postClassroomCompletionRecords = async () => {throw new Error('must not POST');};
  const result = await c.runClassroomAutoSyncMode('completion', 'test', {force: true});
  assert.equal(result.ok, true); assert.equal(result.dryRun, true); assert.equal(result.previewCount, 1);
  assert.equal(local.values.lastClassroomCompletionAutoSyncAt, undefined);
});
test('automatic inCampus sync respects stored preview and does not advance timestamp', async () => {
  const {c, local} = content({previewOnly: true});
  c.location = new URL('https://ic.ss.senshu-u.ac.jp/portal/home');
  c.fetchInCampusHtml = async () => '<html></html>';
  c.parseReportNotifications = () => [{kind: 'submissionRecord', title: '課題'}];
  c.dedupeNotifications = items => items;
  c.buildSubmissionRecordAssignment = () => ({title: '課題', type: 'submissionRecord'});
  c.postAssignment = async () => {throw new Error('must not POST');};
  const result = await c.syncInCampusAssignments({force: true});
  assert.equal(result.ok, true); assert.equal(result.previewCount, 1);
  assert.equal(local.values.lastInCampusAutoSyncAt, undefined);
});
test('mixed batch result preserves counters and failed item labels in UI status', () => {
  const {c} = content();
  const status = {items: [0, 1].map(i => ({action: 'completed', pageUrl: record(i).classroomUrl})), errors: []};
  c.applyClassroomPostResult(status, {ok: false, result: {sentCount: 1, matchedCount: 1, failedCount: 1, results: [
    {recordIndex: 0, matched: true}, {recordIndex: 1, failed: true, reason: 'offline'}
  ], errors: ['offline']}}, 'error');
  assert.equal(status.ok, false); assert.equal(status.sentCount, 1); assert.equal(status.matchedCount, 1);
  assert.equal(status.items[0].action, 'completed'); assert.equal(status.items[1].action, 'failed');
});
test('failed home synchronization does not set successful timestamp', async () => {
  const {c, local} = content();
  c.runClassroomAutoSyncModeInHiddenFrame = async mode => ({ok: mode === 'completion', errors: mode === 'completion' ? [] : ['load failed']});
  const result = await c.startClassroomHomeAutoSyncSequence('test');
  assert.equal(result.ok, false); assert.equal(local.values.lastClassroomHomeAutoSyncAt, undefined);
});
test('home preview and hidden frame failures do not suppress later attempts', async () => {
  const {c, local} = content();
  c.runClassroomAutoSyncModeInHiddenFrame = async () => ({ok: true, dryRun: true, previewCount: 1, errors: []});
  const result = await c.startClassroomHomeAutoSyncSequence('test');
  assert.equal(result.previewOnly, true); assert.equal(local.values.lastClassroomHomeAutoSyncAt, undefined);
  const second = content();
  second.c.loadClassroomDocumentInHiddenFrame = async () => {throw new Error('timeout');};
  const failed = await second.c.runClassroomAutoSyncModeInHiddenFrame('completion', 'test');
  assert.equal(failed.ok, false); assert.match(failed.errors[0], /timeout/);
});
test('blank, wrong URL and generic navigation labels cannot establish readiness', () => {
  const {c, document} = content();
  document.body.textContent = '完了\n提出済み\n期限なし';
  assert.equal(c.getClassroomDocumentReadiness(document, 'completion', document.URL).ok, false);
  document.URL = 'about:blank';
  document.body.textContent = '提出済みの課題はありません';
  assert.equal(c.getClassroomDocumentReadiness(document, 'completion', c.location.href).ok, false);
  assert.equal(c.isExpectedClassroomUrl('https://evil.example/?u=/a/turned-in/all', 'completion'), false);
});
test('explicit empty state on expected complete page is accepted without POST', () => {
  const {c, document} = content();
  document.body.textContent = '提出済みの課題はありません';
  const result = c.extractClassroomCompletionRecordsFromDocument(document, document.URL);
  assert.equal(result.ok, true); assert.equal(result.records.length, 0);
});
test('blank hidden document times out instead of returning zero success', async () => {
  const {c, document} = content();
  document.URL = 'about:blank';
  const frame = {contentDocument: document, contentWindow: {location: {href: 'about:blank'}}};
  await assert.rejects(c.waitForHiddenClassroomFrame(frame, 'completion'), /時間内/);
});
test('hidden frame needs stable expected URL and actual cards', async () => {
  const {c, document} = content();
  c.getClassroomAssignmentAnchors = () => [{}];
  const frame = {contentDocument: document, contentWindow: {location: {href: document.URL}}};
  const result = await c.waitForHiddenClassroomFrame(frame, 'completion');
  assert.equal(result, document);
});
test('mutually exclusive Classroom sections collect all 60 + 141 cards', async () => {
  const {c, document} = content();
  const sections = [{name: '期限なし', count: 60}, {name: 'それ以前', count: 141}];
  let active = 0;
  const expanded = [false, false];
  const buttons = sections.map((section, index) => ({
    textContent: section.name, closest: () => null, querySelector: () => null,
    getAttribute(name) {return name === 'aria-expanded' ? String(active === index) : '';},
    click() {active = index;}
  }));
  const showAll = {textContent: 'すべて表示', closest: () => null, getAttribute: () => '', querySelector: () => null,
    click() {expanded[active] = true;}};
  document.querySelectorAll = selector => selector.includes('aria-busy') ? [] : [...buttons, ...(expanded[active] ? [] : [showAll])];
  c.getClassroomAssignmentAnchors = () => Array.from({length: expanded[active] ? sections[active].count : 5}, (_, i) => record(active * 1000 + i));
  c.extractClassroomCardData = item => ({...item, courseId: 'COURSE', streamItemId: item.title});
  const result = await c.collectClassroomRecordsFromDocument('completion', document, document.URL);
  assert.equal(result.ok, true); assert.equal(result.records.length, 201);
  assert.deepEqual(expanded, [true, true]);
});
test('time-only deadline keeps missing date blank and midnight intact', () => {
  const {c} = content();
  const due = c.parseClassroomDueText('0:00');
  assert.equal(due.dueTime, '00:00'); assert.equal(due.dueDate, ''); assert.equal(due.dueAt, '');
});
test('a later section remaining busy fails the whole extraction', async () => {
  const {c, document} = content();
  c.expandClassroomSections = async (_root, collect) => {
    await collect();
    document.querySelectorAll = selector => selector.includes('aria-busy') ? [{}] : [];
    await collect();
    return 1;
  };
  c.getClassroomAssignmentAnchors = () => [record(0)];
  c.extractClassroomCardData = item => item;
  const result = await c.collectClassroomRecordsFromDocument('completion', document, document.URL);
  assert.equal(result.ok, false); assert.equal(result.records.length, 1);
  assert.match(result.error, /読み込み中/);
});
test('a slow later section waits for readiness and retains both sections', async () => {
  const {c, document} = content();
  let section = 0;
  let polls = 0;
  c.expandClassroomSections = async (_root, collect) => {
    await collect();
    section = 1;
    document.querySelectorAll = selector => selector.includes('aria-busy') && ++polls < 5 ? [{}] : [];
    await collect();
    return 1;
  };
  c.getClassroomAssignmentAnchors = () => [record(section)];
  c.extractClassroomCardData = item => item;
  const result = await c.collectClassroomRecordsFromDocument('completion', document, document.URL);
  assert.equal(result.ok, true); assert.equal(result.records.length, 2); assert(polls >= 5);
});
test('hidden frame expands sections rendered after its initial blank shell', async () => {
  const {c, document} = content();
  let polls = 0, expanded = false;
  document.querySelectorAll = selector => selector === "[aria-expanded='false']" && ++polls >= 3 ? [{}] : [];
  c.getClassroomAssignmentAnchors = () => expanded ? [{}] : [];
  c.expandClassroomSections = async () => {expanded = true;};
  const frame = {contentDocument: document, contentWindow: {location: {href: document.URL}}};
  assert.equal(await c.waitForHiddenClassroomFrame(frame, 'completion'), document);
  assert.equal(expanded, true);
});
test('a card explicitly marked 未提出 in completion list is not completed', () => {
  const {c, document} = content();
  c.getClassroomAssignmentAnchors = () => [record(0), record(1)];
  c.extractClassroomCardData = item => ({...item, statusText: item.title === '課題0' ? '未提出' : '採点済み'});
  const result = c.extractClassroomCompletionRecordsFromDocument(document, document.URL);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].title, '課題1');
});
test('observed Classroom ToDo empty text is accepted for course-filtered manual extraction', () => {
  const {c, document} = content();
  document.URL = 'https://classroom.google.com/a/not-turned-in/COURSE123';
  document.body.textContent = '現在 ToDo リストには何もありません\nまた後で新しい課題がないか確認してください';
  const result = c.extractClassroomDueTimeRecordsFromDocument(document, document.URL);
  assert.equal(result.ok, true); assert.equal(result.records.length, 0);
  assert.equal(c.isExpectedClassroomUrl(document.URL, 'dueTime'), false, 'hidden all-courses navigation must not accept a course redirect');
  document.URL = 'https://classroom.google.com/a/not-turned-in/all';
  assert.equal(c.getClassroomDocumentReadiness(document, 'dueTime', document.URL).ok, true);
});
test('hidden persistent progress indicators do not prevent a loaded page', () => {
  const {c, document} = content();
  document.body.textContent = '現在 ToDo リストには何もありません';
  document.querySelectorAll = selector => selector.includes('aria-busy') ? [
    {hidden: true}, {getClientRects: () => []}, {closest: () => ({})}
  ] : [];
  assert.equal(c.getClassroomDocumentReadiness(document, 'completion', document.URL).ok, true);
});

(async () => {
  let failed = 0;
  for (const {name, fn} of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
