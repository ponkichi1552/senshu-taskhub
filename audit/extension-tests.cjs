// Offline regression checks for the inCampus-only Chrome extension.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
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
function background(initial = {}) {
  const local = storage({
    webAppUrl: 'https://script.google.com/macros/s/TEST/exec',
    apiToken: 'a'.repeat(64),
    ...initial
  });
  const requests = [];
  let listener;
  const c = vm.createContext({
    URL, AbortController, console, Date,
    setTimeout: () => 1, clearTimeout() {},
    chrome: {storage: {local}, runtime: {onMessage: {addListener(fn) { listener = fn; }}}},
    fetch: async (url, options = {}) => {
      requests.push({url, options});
      const payload = options.method === 'POST' ? JSON.parse(options.body) : null;
      if (initial.onPost) await initial.onPost(payload, local);
      const result = payload?.action === 'upsertInCampusAssignments'
        ? {ok: true, results: payload.assignments.map((_, index) => ({updated: true, row: index + 2}))}
        : {ok: true, updated: true, row: 2};
      const responseResult = initial.batchUnsupported && payload?.action === 'upsertInCampusAssignments'
        ? {ok: false, error: '未対応のactionです: upsertInCampusAssignments'}
        : initial.respond ? await initial.respond(payload, requests.length) : result;
      return {
        ok: true,
        status: 200,
        headers: {get: () => 'application/json'},
        text: async () => JSON.stringify(options.method === 'GET' ? {ok: true} : responseResult)
      };
    }
  });
  vm.runInContext(source('background.js'), c);
  return {c, local, requests, message: message => new Promise(resolve => listener(message, {}, resolve))};
}
function content(initial = {}, options = {}) {
  const local = options.local || storage(initial);
  const messages = [];
  let listener;
  const location = new URL('https://ic.ss.senshu-u.ac.jp/portal/home');
  const domWindow = new JSDOM(options.html || '', {url: location.href}).window;
  const window = Object.assign(options.html ? domWindow : {}, {
    __taskhubAutoSyncWatcherInstalled: true,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    addEventListener() {}
  });
  const document = options.html ? domWindow.document : {
    URL: location.href,
    readyState: 'complete',
    hidden: false,
    body: {textContent: ''},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const history = {pushState() {}, replaceState() {}};
  const c = vm.createContext({
    URL, URLSearchParams, AbortController, console, Date, location, window, document, history, DOMParser: domWindow.DOMParser,
    chrome: {
      storage: {local},
      runtime: {
        onMessage: {addListener(fn) { listener = fn; }},
        sendMessage: async message => {
          messages.push(message);
          if (options.background) return options.background.message(message);
          if (message.type === 'GET_HUB_CONNECTION_STATUS') return {ok: true};
          if (message.type === 'POST_INCAMPUS_ASSIGNMENT') return {ok: true, result: {updated: true}};
          if (message.type === 'POST_INCAMPUS_ASSIGNMENTS') return {
            ok: true,
            result: {results: message.assignments.map((_, index) => ({updated: true, row: index + 2}))}
          };
          return {ok: true};
        }
      }
    },
    fetch: async () => ({ok: true, text: async () => '<html></html>'})
  });
  vm.runInContext(source('content.js'), c);
  return {c, local, messages, document, message: message => new Promise(resolve => {
    const keepChannelOpen = listener(message, {}, resolve);
    if (!keepChannelOpen) resolve(undefined);
  })};
}

function popupWithDelayedSettings(options = {}) {
  const ids = [
    'extract', 'copy', 'send', 'clear', 'syncNow', 'reloadStatus', 'incampusDebug',
    'checkSetup', 'webAppUrl', 'apiToken', 'toggleApiToken', 'autoSyncEnabled',
    'syncLimit', 'previewOnly', 'status', 'syncSummary', 'output', 'openUniversityNotices'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, {
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    className: '', listeners: {},
    classList: {toggle() {}},
    addEventListener(type, handler) { this.listeners[type] = handler; }
  }]));
  let releaseSettings;
  const settingsRead = new Promise(resolve => { releaseSettings = resolve; });
  const messages = [];
  const c = vm.createContext({
    URL, Set, console, Date, navigator: {clipboard: {writeText: async () => {}}},
    document: {getElementById: id => elements[id]},
    chrome: {
      storage: {local: {
        get: async () => settingsRead,
        set: async () => {}
      }},
      runtime: {sendMessage: async message => {
        messages.push(message);
        if (options.onRuntimeMessage) return options.onRuntimeMessage(message);
        return {ok: true, message: 'URLへ到達できました。status=200'};
      }},
      tabs: {
        query: async () => [{id: 1, url: 'https://ic.ss.senshu-u.ac.jp/portal/home'}],
        sendMessage: async (_tabId, message) => message?.type === 'EXTRACT_INCAMPUS_ASSIGNMENT_FROM_PAGE' && options.assignment
          ? {ok:true,assignment:typeof options.assignment==='function' ? options.assignment() : options.assignment}
          : {ok: true, isHomePage: true},
        create: async () => {}
      }
    }
  });
  vm.runInContext(source('popup.js'), c);
  return {elements, messages, releaseSettings};
}

test('all extension scripts parse and manifest is valid', () => {
  for (const file of ['background.js', 'content.js', 'popup.js']) new vm.Script(source(file), {filename: file});
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://ic.ss.senshu-u.ac.jp/*']);
  assert(!manifest.host_permissions.some(value => value.includes('classroom.google.com')));
});
test('extension package no longer exposes Classroom reading or controls', () => {
  for (const file of ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'content.js']) {
    assert.doesNotMatch(source(file), /classroom/i, `${file} must not include Classroom extension code`);
  }
});
test('popup JavaScript references only controls present in its HTML', () => {
  const html = source('popup.html');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const references = [...source('popup.js').matchAll(/getElementById\("([^"]+)"\)/g)].map(match => match[1]);
  assert(references.length > 0);
  assert.deepEqual(references.filter(id => !ids.has(id)), []);
});
test('setup check waits for stored production settings before reporting missing values', async () => {
  const {elements, messages, releaseSettings} = popupWithDelayedSettings();
  const check = elements.checkSetup.listeners.click();
  await Promise.resolve();
  assert.equal(messages.length, 0);
  assert.equal(elements.output.textContent, '');

  releaseSettings({
    webAppUrl: 'https://script.google.com/macros/s/PRODUCTION/exec',
    apiToken: 'a'.repeat(64),
    autoSyncEnabled: true,
    syncLimit: 25,
    previewOnly: true
  });
  await check;

  assert(messages.some(message => message.type === 'DIAGNOSE_HUB_WEB_APP_URL'));
  assert.match(elements.output.textContent, /\[OK\] GAS WebアプリURL/);
  assert.match(elements.output.textContent, /\[OK\] APIトークン/);
  assert.doesNotMatch(elements.output.textContent, /未設定です/);
});
test('inCampus assignment POST includes the API token in the JSON body', async () => {
  const {message, requests} = background();
  const result = await message({type: 'POST_INCAMPUS_ASSIGNMENT', assignment: {title: '仮想課題'}});
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'POST');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.action, 'upsertInCampusAssignment');
  assert.equal(payload.apiToken, 'a'.repeat(64));
  assert.equal(payload.assignment.title, '仮想課題');
});
test('repeated manual send clicks issue only one request while the first save is pending', async () => {
  let finishSave;const pending=new Promise(resolve=>{finishSave=resolve;});
  const p=popupWithDelayedSettings({assignment:{title:'仮想課題A'},onRuntimeMessage:async()=>pending});
  p.releaseSettings({webAppUrl:'https://script.google.com/macros/s/TEST/exec',apiToken:'a'.repeat(64),previewOnly:false});
  await p.elements.extract.listeners.click();
  const first=p.elements.send.listeners.click(),second=p.elements.send.listeners.click();
  await new Promise(setImmediate);
  try {
    assert.equal(p.messages.filter(m=>m.type==='POST_INCAMPUS_ASSIGNMENT').length,1);
    assert.equal(p.elements.send.disabled,true);
  } finally {finishSave({ok:true,result:{updated:true,unchanged:true}});await Promise.all([first,second]);}
  assert.equal(p.elements.send.disabled,false);
  assert.match(p.elements.status.textContent,/変更はありません/);
});
test('an older manual save response does not overwrite a newly extracted assignment status', async () => {
  let finishSave,assignment={title:'仮想課題A'};const pending=new Promise(resolve=>{finishSave=resolve;});
  const p=popupWithDelayedSettings({assignment:()=>assignment,onRuntimeMessage:async()=>pending});
  p.releaseSettings({webAppUrl:'https://script.google.com/macros/s/TEST/exec',apiToken:'a'.repeat(64),previewOnly:false});
  await p.elements.extract.listeners.click();const save=p.elements.send.listeners.click();await new Promise(setImmediate);
  assignment={title:'仮想課題B'};await p.elements.extract.listeners.click();
  finishSave({ok:true,result:{updated:true,unchanged:true}});await save;
  assert.match(p.elements.output.textContent,/仮想課題B/);
  assert.equal(p.messages.find(m=>m.type==='POST_INCAMPUS_ASSIGNMENT').assignment.title,'仮想課題A');
  assert.equal(p.elements.status.textContent,'抽出できました。');
});
test('preview mode blocks the inCampus POST', async () => {
  const {message, requests} = background({previewOnly: true});
  const result = await message({type: 'POST_INCAMPUS_ASSIGNMENT', assignment: {title: '仮想課題'}});
  assert.equal(result.ok, true);
  assert.equal(result.result.dryRun, true);
  assert.equal(requests.length, 0);
});
test('multiple inCampus records use one authenticated batch POST', async () => {
  const {message, requests} = background();
  const assignments = [{title: '仮想課題A'}, {title: '仮想お知らせB'}];
  const result = await message({type: 'POST_INCAMPUS_ASSIGNMENTS', assignments});
  assert.equal(result.ok, true);
  assert.equal(result.result.results.length, 2);
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.action, 'upsertInCampusAssignments');
  assert.equal(payload.apiToken, 'a'.repeat(64));
  assert.deepEqual(payload.assignments, assignments);
});
test('an older production Hub falls back from rejected batch action to supported single-row POSTs', async () => {
  const {message, requests} = background({batchUnsupported: true});
  const assignments = [{title: '仮想課題A'}, {title: '仮想お知らせB'}];
  const result = await message({type: 'POST_INCAMPUS_ASSIGNMENTS', assignments});

  assert.equal(result.ok, true);
  assert.equal(result.result.results.length, 2);
  assert.ok(result.result.results.every(item => item.updated));
  assert.deepEqual(requests.map(request => JSON.parse(request.options.body).action), [
    'upsertInCampusAssignments', 'upsertInCampusAssignment', 'upsertInCampusAssignment'
  ]);
});
test('batch preview returns one dry-run result per record without posting', async () => {
  const {message, requests} = background({previewOnly: true});
  const result = await message({type: 'POST_INCAMPUS_ASSIGNMENTS', assignments: [{title: 'A'}, {title: 'B'}]});
  assert.equal(result.ok, true);
  assert.equal(result.result.dryRun, true);
  assert.equal(result.result.results.length, 2);
  assert.ok(result.result.results.every(item => item.dryRun));
  assert.equal(requests.length, 0);
});
test('a preview switch between chunks stops later posts and marks remaining records', async () => {
  const {c, requests, local} = background({onPost: async (payload, saved) => {
    if (payload?.action === 'upsertInCampusAssignments') saved.values.previewOnly = true;
  }});
  const assignments = [{title: 'A'.repeat(100000)}, {title: 'B'.repeat(100000)}];
  const result = await c.postAssignmentsToHub(assignments);
  assert.equal(requests.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.result.results.length, 2);
  assert.equal(result.result.results[0].updated, true);
  assert.equal(result.result.results[1].dryRun, true);
  assert.match(result.error, /プレビュー設定/);
  assert.equal(local.values.previewOnly, true);
});
test('URL setup check makes a GET request and reports success', async () => {
  const {c, requests} = background();
  const result = await c.diagnoseHubWebAppUrl('https://script.google.com/macros/s/TEST/exec');
  assert.equal(result.ok, true);
  assert.equal(requests[0].options.method, 'GET');
});
test('inCampus preview parses and summarizes without posting', async () => {
  const {c, messages} = content({previewOnly: true});
  const assignment = {type: 'submissionRecord', title: '仮想提出通知', pageUrl: 'https://ic.ss.senshu-u.ac.jp/report/1'};
  c.fetchInCampusHtml = async () => '<html></html>';
  c.parseReportNotifications = () => [{kind: 'submissionRecord', title: assignment.title}];
  c.dedupeNotifications = rows => rows;
  c.buildSubmissionRecordAssignment = () => assignment;
  const result = await c.syncInCampusAssignments({force: true});
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.submissionRecordCount, 1);
  assert.equal(result.previewCount, 1);
  assert(!messages.some(message => message.type === 'POST_INCAMPUS_ASSIGNMENT'));
});
test('inCampus sync sends a parsed record and stores the result', async () => {
  const {c, messages} = content({previewOnly: false});
  const assignment = {type: 'submissionRecord', title: '仮想提出通知', pageUrl: 'https://ic.ss.senshu-u.ac.jp/report/2'};
  c.fetchInCampusHtml = async () => '<html></html>';
  c.parseReportNotifications = () => [{kind: 'submissionRecord', title: assignment.title}];
  c.dedupeNotifications = rows => rows;
  c.buildSubmissionRecordAssignment = () => assignment;
  const result = await c.syncInCampusAssignments({force: true});
  assert.equal(result.ok, true);
  assert.equal(result.sentCount, 1);
  assert.equal(result.updatedCount, 1);
  assert(messages.some(message => message.type === 'POST_INCAMPUS_ASSIGNMENTS' && message.assignments[0].title === assignment.title));
  assert(messages.some(message => message.type === 'SAVE_INCAMPUS_SYNC_STATUS'));
});
test('inCampus sync batches multiple records in one content-to-background message', async () => {
  const {c, messages} = content({previewOnly: false});
  const assignments = [
    {type: 'submissionRecord', title: '仮想提出A', pageUrl: 'https://ic.ss.senshu-u.ac.jp/report/3'},
    {type: 'submissionRecord', title: '仮想提出B', pageUrl: 'https://ic.ss.senshu-u.ac.jp/report/4'}
  ];
  c.fetchInCampusHtml = async () => '<html></html>';
  c.parseReportNotifications = () => assignments.map(item => ({kind: 'submissionRecord', title: item.title}));
  c.dedupeNotifications = rows => rows;
  c.buildSubmissionRecordAssignment = notification => assignments.find(item => item.title === notification.title);
  const result = await c.syncInCampusAssignments({force: true});
  assert.equal(result.ok, true);
  assert.equal(result.sentCount, 2);
  const posts = messages.filter(message => message.type === 'POST_INCAMPUS_ASSIGNMENTS');
  assert.equal(posts.length, 1);
  assert.deepEqual(Array.from(posts[0].assignments, item => item.title), ['仮想提出A', '仮想提出B']);
});
test('inCampus detail pages fetch concurrently with bounded concurrency, stable order, and URL deduplication', async () => {
  const {c} = content();
  const notifications = [
    {kind: 'assignment', detailUrl: '/lms/course/report/1', titleFromUpdate: '課題A'},
    {kind: 'assignment', detailUrl: '/lms/course/report/2', titleFromUpdate: '課題B'},
    {kind: 'announcement', detailUrl: '/portal/notice/1', titleFromUpdate: 'お知らせA'},
    {kind: 'assignment', detailUrl: '/lms/course/report/1', titleFromUpdate: '課題Aの更新'},
    {kind: 'submissionRecord', detailUrl: '/updateinfo/1', titleFromUpdate: '提出A'},
    {kind: 'assignment', detailUrl: '/lms/course/report/3', titleFromUpdate: '課題C'},
    {kind: 'assignment', detailUrl: '/lms/course/report/4', titleFromUpdate: '課題D'}
  ];
  c.parseReportNotifications = () => notifications;
  c.dedupeNotifications = records => records;
  c.buildInCampusAnnouncement = notification => ({type: 'announcement', title: notification.titleFromUpdate});
  c.buildSubmissionRecordAssignment = notification => ({type: 'submissionRecord', title: notification.titleFromUpdate});
  c.extractAssignmentFromDetailHtml = (_html, pageUrl, notification) => ({
    type: 'assignment', title: notification.titleFromUpdate, pageUrl
  });

  let activeFetches = 0;
  let peakFetches = 0;
  const fetchedUrls = [];
  c.fetchInCampusHtml = async url => {
    activeFetches++;
    peakFetches = Math.max(peakFetches, activeFetches);
    fetchedUrls.push(url);
    await Promise.resolve();
    activeFetches--;
    return `html:${url}`;
  };

  const result = await c.collectInCampusAssignmentsFromHtml('<html></html>', notifications.length);

  assert.equal(result.foundCount, notifications.length);
  assert.equal(result.detailPageCount, 4);
  assert.equal(fetchedUrls.length, 4);
  assert(peakFetches > 1, 'detail requests should overlap');
  assert(peakFetches <= 4, 'detail request concurrency must stay bounded');
  assert.deepEqual(Array.from(result.assignments, item => item.title), [
    '課題A', '課題B', 'お知らせA', '課題Aの更新', '提出A', '課題C', '課題D'
  ]);
});
test('same inCampus detail URL is fetched only once per collection', async () => {
  const {c} = content();
  let detailFetches = 0;
  c.parseReportNotifications = () => [
    {kind: 'assignment', detailUrl: 'https://ic.ss.senshu-u.ac.jp/lms/course/report/1', titleFromUpdate: '課題A'},
    {kind: 'assignment', detailUrl: 'https://ic.ss.senshu-u.ac.jp/lms/course/report/1', titleFromUpdate: '課題B'}
  ];
  c.dedupeNotifications = rows => rows;
  c.fetchInCampusHtml = async url => { if (url.includes('/report/')) detailFetches++; return '<html></html>'; };
  c.extractAssignmentFromDetailHtml = (_html, _url, notification) => ({type: 'assignment', title: notification.titleFromUpdate});
  const result = await c.collectInCampusAssignmentsFromHtml('<html></html>', 25);
  assert.equal(result.assignments.length, 2);
  assert.equal(detailFetches, 1);
});
test('overlapping sync requests reserve the in-flight flag before reading settings', async () => {
  const {c, messages} = content({previewOnly: true});
  let updateInfoFetches = 0;
  c.fetchInCampusHtml = async () => { updateInfoFetches++; return '<html></html>'; };
  c.parseReportNotifications = () => [];
  const results = await Promise.all([
    c.syncInCampusAssignments({force: true}),
    c.syncInCampusAssignments({force: true})
  ]);
  assert.equal(updateInfoFetches, 1);
  assert.equal(results.filter(result => result.skipped).length, 1);
  assert.equal(messages.filter(message => message.type === 'SAVE_INCAMPUS_SYNC_STATUS').length, 1);
});
test('manual successful save cooldown prevents an immediate lifecycle-triggered duplicate fetch', async () => {
  const {c, local} = content({previewOnly: false});
  let updateInfoFetches = 0;
  c.fetchInCampusHtml = async () => { updateInfoFetches++; return '<html></html>'; };
  c.parseReportNotifications = () => [];
  const manual = await c.syncInCampusAssignments({force: true});
  const auto = await c.syncInCampusAssignments({force: false});
  assert.equal(manual.ok, true);
  assert.ok(local.values.lastInCampusSyncAttemptAt > 0);
  assert.ok(local.values.lastInCampusAutoSyncAt > 0);
  assert.equal(auto.skipped, true);
  assert.equal(updateInfoFetches, 1);
});
test('missing Hub configuration is recorded before fetching inCampus data', async () => {
  const {c, messages, local} = content({previewOnly: false});
  let updateInfoFetches = 0;
  c.getHubConnectionStatus = async () => ({ok: false, error: '接続設定なし'});
  c.fetchInCampusHtml = async () => { updateInfoFetches++; return '<html></html>'; };
  const result = await c.syncInCampusAssignments({force: false});
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(updateInfoFetches, 0);
  assert.ok(local.values.lastInCampusSyncAttemptAt > 0);
  assert.equal(local.values.lastInCampusAutoSyncAt, undefined);
  assert(messages.some(message => message.type === 'SAVE_INCAMPUS_SYNC_STATUS'));
});
test('automatic sync respects its OFF setting', async () => {
  const {c, messages} = content({autoSyncEnabled: false, previewOnly: false});
  const result = await c.syncInCampusAssignments();
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert(!messages.some(message => message.type === 'POST_INCAMPUS_ASSIGNMENT'));
});
test('content script answers inCampus health checks and ignores removed Classroom routes', async () => {
  const {message, c} = content();
  const ping = await message({type: 'PING_INCAMPUS_CONTENT'});
  assert.equal(ping.ok, true);
  assert.equal(ping.isInCampusPage, true);
  assert.equal(ping.isHomePage, true);
  assert.equal(await message({type: 'RUN_CLASSROOM_COMPLETION_SYNC'}), undefined);
  assert.equal(typeof c.syncInCampusAssignments, 'function');
});

function updateRow(text, {course='火5 仮想情報演習', report='R1', event='E1', url='/lms/course/report/submission?idnumber=VIRTUAL&reportId=R1', hiddenIds=true, spans=true} = {}) {
  const inputs = hiddenIds ? `<input id="idnumber" type="hidden" value="VIRTUAL"><input id="contentId" type="hidden" value="${report}"><input id="updateInfoId" type="hidden" value="${event}">` : `<input type="checkbox" name="deleteUpdateInfoList" value="2-${event}">`;
  return `<div class="update-info-student"><div class="update-info-url"><label>2026/12/30 09:00</label><button class="updateInfoUrl" value="${url}">${spans ? `<span>[${course}]</span><span>・${text}</span>` : `[${course}] ・${text}`}</button></div>${inputs}</div>`;
}
const updatePage = (...rows) => `<form id="updateInfoForm">${rows.join('')}</form>`;
const detailFixture = fs.readFileSync(path.join(__dirname,'fixtures/incampus/report.html'),'utf8');
const detailUrl = 'https://ic.ss.senshu-u.ac.jp/lms/course/report/submission?idnumber=VIRTUAL&reportId=R1';

test('actual inCampus row structure keeps nested titles, distinct notices, and submissions while excluding material/survey rows', () => {
  const {c}=content();
  const html=updatePage(
    updateRow('課題(仮想課題（第２回）)が更新されました。'),
    updateRow('課題(仮想課題（第２回）)が追加されました。',{event:'E2'}),
    updateRow('課題(仮想課題（第２回）)を提出しました。',{event:'E3'}),
    updateRow('お知らせ(仮想連絡A)が追加されました。',{report:'N1',event:'E4',url:'/lms/course/VIRTUAL'}),
    updateRow('お知らせ(仮想連絡B)が追加されました。',{report:'N2',event:'E5',url:'/lms/course/VIRTUAL'}),
    updateRow('資料(課題の説明)が追加されました。',{report:'M1'}),
    updateRow('授業アンケート(課題について)が追加されました。',{report:'Q1'})
  );
  const records=c.dedupeNotifications(c.parseReportNotifications(html));
  assert.equal(records.length,4);
  assert.deepEqual(Array.from(records,r=>r.kind),['assignment','submissionRecord','announcement','announcement']);
  assert.equal(records[0].titleFromUpdate,'仮想課題（第２回）');
  assert.equal(records[1].titleFromUpdate,'仮想課題（第２回）');
  assert.notEqual(records[0].assignmentKey,records[1].assignmentKey);
  assert.notEqual(records[2].assignmentKey,records[3].assignmentKey);
});
test('visible report text keeps line breaks and filenames without hidden storage metadata or submitted files', () => {
  const {c}=content();
  const result=c.extractAssignmentFromDetailHtml(detailFixture,detailUrl,{courseName:'仮想情報演習',assignmentKey:'R1'});
  assert.equal(result.body,'第１段落。\n\n第２段落。\n最後の行。');
  assert.equal(result.attachment,'仮想課題.pdf\n\n仮想見本.docx');
  assert.doesNotMatch(result.attachment,/storage-id|内部入力|仮想提出ファイル/);
  assert.equal(result.startAt,'2026-12-30 09:00');
  assert.equal(result.dueAt,'2027-01-05 24:00');
});
test('empty teacher attachments never fall back to submitted files or similar unrelated labels', () => {
  const {c}=content();
  const html='<div class="contents-detail"><div class="contents-header">タイトル</div><div class="contents-input-area">仮想空欄課題</div></div>'+
    '<div class="contents-detail"><div class="contents-header">内容</div><div class="contents-input-area">課題本文</div></div>'+
    '<div class="contents-detail"><div class="contents-header">添付ファイル</div><div class="contents-input-area"></div></div>'+
    '<div class="contents-detail"><div class="contents-header">提出済み添付ファイル</div><div class="contents-input-area">仮想提出ファイル.pdf</div></div>';
  const result=c.extractAssignmentFromDetailHtml(html,detailUrl,{});
  assert.equal(result.attachment,'');
  assert.equal(c.findDetailValue({'提出者詳細':'仮想個人情報'},['詳細']),'');
});
test('a recognized report with an empty body and no deadline remains a valid assignment', () => {
  const {c}=content();
  const html='<div class="contents-detail"><div class="contents-header">課題名</div><div class="contents-input-area">仮想タイトルのみ</div></div>'+
    '<div class="contents-detail"><div class="contents-header">内容</div><div class="contents-input-area"></div></div>'+
    '<div class="contents-detail"><div class="contents-header">提出期間</div><div class="contents-input-area"></div></div>';
  const result=c.extractAssignmentFromDetailHtml(html,detailUrl,{});
  assert(result);assert.equal(result.title,'仮想タイトルのみ');assert.equal(result.body,'');assert.equal(result.dueAt,'');
});
test('missing hidden IDs use URL identity and visible row IDs without collapsing different notices', () => {
  const {c}=content();
  const records=c.dedupeNotifications(c.parseReportNotifications(updatePage(
    updateRow('課題(A)が追加されました。',{hiddenIds:false,event:'11'}),
    updateRow('お知らせ(A)が追加されました。',{hiddenIds:false,event:'12',url:'/lms/course/VIRTUAL'}),
    updateRow('お知らせ(B)が追加されました。',{hiddenIds:false,event:'13',url:'/lms/course/VIRTUAL'})
  )));
  assert.equal(records.length,3);assert.equal(records[0].reportId,'R1');
  assert.equal(records[0].idnumber,'VIRTUAL');assert.notEqual(records[1].assignmentKey,records[2].assignmentKey);
});
test('a row without nested spans still extracts its course and notice', () => {
  const {c}=content();const records=c.parseReportNotifications(updatePage(updateRow('お知らせ(仮想連絡)が追加されました。',{spans:false})));
  assert.equal(records.length,1);assert.equal(records[0].courseName,'火5 仮想情報演習');assert.equal(records[0].titleFromUpdate,'仮想連絡');
});
test('login or unrelated HTML fails instead of reporting a successful empty update list', () => {
  const {c}=content();assert.throws(()=>c.parseReportNotifications('<form id="loginForm">ログイン</form>'),/更新一覧を確認/);
  assert.equal(c.parseReportNotifications('<form id="updateInfoForm">更新通知はありません</form>').length,0);
  assert.equal(c.extractAssignmentFromDetailHtml('<div class="contents-detail"><label>本文</label><div class="contents-input-area">ログインしてください</div></div>',detailUrl,{titleFromUpdate:'仮想課題'}),null);
});
test('HTTP failures and login redirects are surfaced before parsing', async () => {
  const {c}=content();
  c.fetch=async()=>({ok:true,url:'https://ic.ss.senshu-u.ac.jp/login',text:async()=>'<html></html>'});
  await assert.rejects(c.fetchInCampusHtml(detailUrl),/ログイン状態/);
  c.fetch=async()=>({ok:false,status:503,text:async()=>''});
  await assert.rejects(c.fetchInCampusHtml(detailUrl),/status=503/);
});
test('reading timeout aborts the request and reports a bounded failure', async () => {
  const {c}=content();c.window.setTimeout=fn=>{fn();return 1;};
  c.fetch=async(_url,{signal})=>{assert(signal.aborted);const error=new Error('aborted');error.name='AbortError';throw error;};
  await assert.rejects(c.fetchInCampusHtml(detailUrl),/15秒でタイムアウト/);
});
test('foreign origins, alternate ports, credentials and course overviews are never report details', () => {
  const {c}=content();
  for(const url of ['https://evil.example/report/1','https://ic.ss.senshu-u.ac.jp:444/report/1','https://name:secret@ic.ss.senshu-u.ac.jp/report/1']) assert.equal(c.toAbsoluteInCampusUrl(url),'');
  assert.equal(c.extractAssignmentFromDetailHtml(detailFixture,'https://ic.ss.senshu-u.ac.jp/lms/course/VIRTUAL',{}),null);
});
test('one unreadable detail preserves other records and reports the missing item', async () => {
  const {c}=content();c.fetchInCampusHtml=async url=>{if(url.includes('reportId=R1'))throw new Error('detail unavailable');return detailFixture;};
  const result=await c.collectInCampusAssignmentsFromHtml(updatePage(
    updateRow('課題(A)が追加されました。'),
    updateRow('課題(B)が追加されました。',{report:'R2',url:'/lms/course/report/submission?idnumber=VIRTUAL&reportId=R2'}),
    updateRow('お知らせ(連絡)が追加されました。',{report:'N1',url:'/lms/course/VIRTUAL'})
  ),25);
  assert.equal(result.assignments.length,2);assert.equal(result.errors.length,1);assert.match(result.errors[0],/unavailable/);
});
test('the configured limit reports eligible records left uncollected', async () => {
  const {c}=content();const html=updatePage(...Array.from({length:12},(_,i)=>updateRow(`お知らせ(仮想連絡${i})が追加されました。`,{report:`N${i}`,event:`E${i}`,url:'/lms/course/VIRTUAL'})));
  const result=await c.collectInCampusAssignmentsFromHtml(html,10);
  assert.equal(result.assignments.length,10);assert.equal(result.eligibleCount,12);assert.equal(result.skippedByLimitCount,2);
});
test('current report extraction identifies the course and report URL parameters', () => {
  const {c}=content({}, {html:detailFixture});c.location=new URL(detailUrl);
  const result=c.extractInCampusAssignmentFromCurrentPage();
  assert.equal(result.ok,true);assert.equal(result.assignment.courseName,'仮想情報演習');assert.equal(result.assignment.idnumber,'VIRTUAL');assert.equal(result.assignment.reportId,'R1');
});
test('per-record server failures and invalid saved rows cannot appear successful', async () => {
  const {c}=background({respond:()=>({ok:true,results:[{updated:true,row:2},{ok:false,error:'保存拒否'},{updated:true,row:0}]})});
  const result=await c.postAssignmentsToHub([{title:'A'},{title:'B'},{title:'C'}]);
  assert.equal(result.ok,false);assert.equal(result.result.results[0].updated,true);assert.equal(result.result.results[1].ok,false);assert.equal(result.result.results[2].ok,false);
});
test('missing success marker or incomplete response never counts as saved', async () => {
  for(const response of [{results:[{row:2,updated:true}]},{ok:true,results:[]}]) {
    const {c}=background({respond:()=>response});const result=await c.postAssignmentsToHub([{title:'A'}]);
    assert.equal(result.ok,false);assert.equal(result.result.results[0].ok,false);
  }
});
test('two inCampus tabs acquire only one lease and perform only one read', async () => {
  const bg=background({previewOnly:true});const first=content({}, {local:bg.local,background:bg});const second=content({}, {local:bg.local,background:bg});
  let reads=0;for(const tab of [first,second]) {tab.c.fetchInCampusHtml=async()=>{reads++;return '<html></html>';};tab.c.parseReportNotifications=()=>[];}
  const results=await Promise.all([first.c.syncInCampusAssignments({force:true}),second.c.syncInCampusAssignments({force:true})]);
  assert.equal(reads,1);assert.equal(results.filter(r=>r.skipped).length,1);assert.equal(bg.local.values.inCampusSyncLease,null);
});
test('expired leases recover and an old release cannot unlock a newer sync', async () => {
  const {c,local}=background({inCampusSyncLease:{token:'old',expiresAt:Date.now()-1}});
  const lease=await c.acquireInCampusSync({force:true});assert(lease.token);
  await c.releaseInCampusSync('old');assert.equal(local.values.inCampusSyncLease.token,lease.token);
  await c.releaseInCampusSync(lease.token);assert.equal(local.values.inCampusSyncLease,null);
});
test('a failed read can retry after one minute instead of suppressing syncing for ten minutes', async () => {
  const {c,local}=content();let now=1000000;c.Date=class extends Date{static now(){return now;}};
  let reads=0;c.fetchInCampusHtml=async()=>{reads++;throw new Error('offline');};
  const failed=await c.syncInCampusAssignments({force:true});assert.equal(failed.ok,false);assert.equal(local.values.lastInCampusAutoSyncAt,undefined);
  assert.equal((await c.syncInCampusAssignments()).skipped,true);now+=60001;
  await c.syncInCampusAssignments();assert.equal(reads,2);
});
test('preview records its own cooldown without advancing successful save time', async () => {
  const {c,local}=content({previewOnly:true});c.fetchInCampusHtml=async()=>'<html></html>';c.parseReportNotifications=()=>[];
  assert.equal((await c.syncInCampusAssignments({force:true})).ok,true);
  assert.equal(local.values.lastInCampusAutoSyncAt,undefined);assert(local.values.lastInCampusPreviewSyncAt>0);
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`PASS ${item.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${item.name}\n${error.stack || error}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
})();
