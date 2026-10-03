// Current offline regression suite. No network access or production writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const os = require('node:os');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..');
let scripts = 0;
function checkSyntax(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {checkSyntax(file); continue;}
    if (!/\.(js|gs|html)$/.test(entry.name)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const chunks = entry.name.endsWith('.html')
      ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
      : [source];
    chunks.forEach(chunk => {new vm.Script(chunk, {filename: file}); scripts++;});
  }
}
checkSyntax(path.join(base, 'taskhub-split'));
checkSyntax(path.join(base, 'taskhub-extension-v2.5'));
const canonical = path.join(base, 'taskhub-split/taskhub-split');
const mirror = path.join(base, 'taskhub-split/workspace/taskhub-split');
for (const name of fs.readdirSync(canonical)) {
  if (!fs.statSync(path.join(canonical, name)).isFile()) continue;
  assert.deepEqual(fs.readFileSync(path.join(canonical, name)), fs.readFileSync(path.join(mirror, name)), `Mirror mismatch: ${name}`);
}
console.log(`PASS syntax (${scripts} scripts) and canonical/mirror equality`);
const indexTemplate = fs.readFileSync(path.join(canonical, 'Index.html'), 'utf8');
const includedTemplates = [...indexTemplate.matchAll(/include\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
for (const name of includedTemplates) assert.ok(fs.existsSync(path.join(canonical, name + '.html')), `Missing HTML include: ${name}`);
for (const name of ['Scripts', 'ScriptsHome', 'ScriptsSettings', 'ScriptsSync', 'ScriptsCourseFilter', 'ScriptsRendering', 'ScriptsActions', 'ScriptsBoot', 'Styles', 'StylesDialogs', 'StylesHome']) {
  assert.ok(includedTemplates.includes(name), `Index.html does not include module: ${name}`);
}
console.log('PASS all split style and script modules are included by Index.html');
const appsscriptManifest = JSON.parse(fs.readFileSync(path.join(canonical, 'appsscript.json'), 'utf8'));
assert.equal(appsscriptManifest.webapp.executeAs, 'USER_ACCESSING');
assert.equal(appsscriptManifest.webapp.access, 'DOMAIN');
console.log('PASS Apps Script manifest uses per-user execution with Senshu-domain access');
for (const file of ['server-tests.cjs', 'extension-tests.cjs', 'ui-tests.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    env: {...process.env, TZ: 'Asia/Tokyo'}, encoding: 'utf8'
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('PASS all current regressions');
const localDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-local-sandbox-'));
try {
  const smoke = spawnSync(process.execPath, [path.join(base, 'local-dev/server.cjs'), '--smoke'], {
    env: {...process.env, TASKHUB_LOCAL_DATA_DIR: localDataDir, TZ: 'Asia/Tokyo'}, encoding: 'utf8'
  });
  process.stdout.write(smoke.stdout || '');
  process.stderr.write(smoke.stderr || '');
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) process.exit(smoke.status || 1);
} finally {
  fs.rmSync(localDataDir, {recursive: true, force: true});
}
