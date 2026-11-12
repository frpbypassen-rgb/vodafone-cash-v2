'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { inspectRelease, installRelease } = require('../scripts/installReviewedServerRelease.cjs');
let parent;
let project;
let backup;
let manifest;
let target;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), content); };
const commit = message => { git('add', '.'); git('-c', 'user.name=ReleaseTest', '-c', 'user.email=release@local.invalid', 'commit', '-m', message); return git('rev-parse', 'HEAD'); };
beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ahram-reviewed-release-test-'));
    project = path.join(parent, 'project'); backup = path.join(parent, 'backup');
    fs.mkdirSync(project); git('init');
    write('routes/mobileApi.js', 'old source'); write('models/ExecutorGroup.js', 'old model');
    write('README.md', 'base'); write('package.json', '{}'); write('package-lock.json', '{}');
    const baseCommit = commit('base');
    git('switch', '-c', 'reviewed');
    write('routes/mobileApi.js', 'reviewed merged source'); write('models/ExecutorGroup.js', 'reviewed merged model');
    write('services/executorTeamChatService.js', 'reviewed team chat'); write('package.json', '{"version":"2.0.0"}');
    target = commit('reviewed integration');
    git('switch', '--detach', baseCommit);
    write('routes/mobileApi.js', 'server local source'); write('models/ExecutorGroup.js', 'server local model');
    write('services/executorTeamChatService.js', 'server local team');
    write('save-smtp-pass.js', 'private local content');
    manifest = { baseCommit, files: [
        { path: 'routes/mobileApi.js', tracked: true }, { path: 'models/ExecutorGroup.js', tracked: true },
        { path: 'services/executorTeamChatService.js', tracked: false }
    ].map(entry => ({ ...entry, sha256: hash(fs.readFileSync(path.join(project, entry.path))) })) };
});
afterEach(() => {
    const resolved = path.resolve(parent);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ahram-reviewed-release-test-')) throw new Error('Unsafe test cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
});
test('inspection never changes live source; installation preserves local copies and unrelated private files', () => {
    const before = git('rev-parse', 'HEAD');
    expect(inspectRelease({ project, target, manifest })).toMatchObject({ alreadyInstalled: false, release: target });
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(fs.readFileSync(path.join(project, 'routes/mobileApi.js'), 'utf8')).toBe('server local source');
    installRelease({ project, target, manifest, backup });
    expect(git('rev-parse', 'HEAD')).toBe(target);
    expect(fs.readFileSync(path.join(project, 'routes/mobileApi.js'), 'utf8')).toBe('reviewed merged source');
    expect(fs.readFileSync(path.join(backup, 'files/routes/mobileApi.js'), 'utf8')).toBe('server local source');
    expect(fs.readFileSync(path.join(backup, 'files/services/executorTeamChatService.js'), 'utf8')).toBe('server local team');
    expect(fs.readFileSync(path.join(project, 'save-smtp-pass.js'), 'utf8')).toBe('private local content');
    expect(inspectRelease({ project, target, manifest }).alreadyInstalled).toBe(true);
});
test('a change after review aborts before any source or Git modification', () => {
    write('routes/mobileApi.js', 'a new live edit'); const before = git('rev-parse', 'HEAD');
    expect(() => installRelease({ project, target, manifest, backup })).toThrow('SOURCE_CHANGED');
    expect(git('rev-parse', 'HEAD')).toBe(before); expect(fs.existsSync(backup)).toBe(false);
});
test('unexpected tracked changes abort instead of stashing or discarding them', () => {
    write('README.md', 'unreviewed change');
    expect(() => installRelease({ project, target, manifest, backup })).toThrow('UNREVIEWED_TRACKED_CHANGE');
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('unreviewed change');
});
test('the CLI cannot install while the observed old PID is still running', () => {
    const manifestPath = path.join(parent, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/installReviewedServerRelease.cjs'), '--project', project,
        '--commit', target, '--manifest', manifestPath, '--backup', backup, '--stopped-pid', String(process.pid), '--apply'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('OLD_PROCESS_STILL_RUNNING'); expect(fs.existsSync(backup)).toBe(false);
});
test('the guarded restart invokes reviewed installation after stop and before dependency changes or restart', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/restartAhramAfterDrain.ps1'), 'utf8');
    const stop = source.indexOf('& pm2 stop ahram-pay');
    const install = source.indexOf('--stopped-pid');
    expect(install).toBeGreaterThan(stop);
    expect(install).toBeLessThan(source.indexOf('& $npmCommand install'));
    expect(install).toBeLessThan(source.indexOf('& pm2 restart ahram-pay'));
});
