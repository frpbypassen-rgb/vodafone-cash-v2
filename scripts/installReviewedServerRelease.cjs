'use strict';

// Installs only the exact source snapshot reviewed from the server archive.
// The CLI apply path is called inside restartAhramAfterDrain's closed gate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const fail = code => { throw new Error(code); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (project, args, binary = false) => execFileSync('git', ['-C', project, ...args], {
    windowsHide: true, encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024
});
const lines = output => output.split('\0').filter(Boolean);
const samePath = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
const relativeSource = value => typeof value === 'string'
    && /^(?:models|routes|services|utils|views|scripts)\/[a-zA-Z0-9_./-]+\.(?:js|cjs|ejs)$/.test(value)
    && !value.split('/').some(part => part === '..' || part === '.' || !part);
const fileIn = (root, relative) => {
    if (!relativeSource(relative)) fail('INVALID_MANIFEST_PATH');
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep)) fail('INVALID_MANIFEST_PATH');
    // Do not follow a source directory junction/symlink out of the serving tree.
    let current = root;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('SOURCE_SYMLINK');
    }
    return target;
};
const validateManifest = manifest => {
    if (!/^[a-f0-9]{40}$/.test(manifest?.baseCommit || '') || !Array.isArray(manifest.files)
        || !manifest.files.length || manifest.files.length > 100) fail('INVALID_MANIFEST');
    const seen = new Set();
    for (const file of manifest.files) {
        if (!relativeSource(file.path) || seen.has(file.path) || typeof file.tracked !== 'boolean'
            || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) fail('INVALID_MANIFEST');
        seen.add(file.path);
    }
};

function inspectRelease({ project, target, manifest }) {
    validateManifest(manifest);
    project = fs.realpathSync(project);
    if (!/^[a-f0-9]{40}$/.test(target || '')) fail('INVALID_RELEASE_COMMIT');
    if (!samePath(fs.realpathSync(git(project, ['rev-parse', '--show-toplevel']).trim()), project)) fail('WRONG_PROJECT_ROOT');
    if (git(project, ['ls-files', '-u']).trim()) fail('UNMERGED_INDEX');
    const release = git(project, ['rev-parse', '--verify', target + '^{commit}']).trim();
    const head = git(project, ['rev-parse', 'HEAD']).trim();
    if (head !== manifest.baseCommit && head !== release) fail('SERVER_BASE_CHANGED');
    git(project, ['merge-base', '--is-ancestor', head, release]);
    if (git(project, ['diff', '--cached', '--name-only']).trim()) fail('UNREVIEWED_STAGED_CHANGE');
    const tracked = new Set(manifest.files.filter(file => file.tracked).map(file => file.path));
    const changed = lines(git(project, ['diff', '--name-only', '-z', 'HEAD', '--']));
    for (const file of changed) {
        if (file === 'vodafone-cash-v2') {
            const before = git(project, ['ls-tree', 'HEAD', '--', file]).trim();
            const after = git(project, ['ls-tree', release, '--', file]).trim();
            if (!before.startsWith('160000 ') || before !== after) fail('SUBMODULE_RELEASE_CHANGED');
        } else if (head === release || !tracked.has(file)) fail('UNREVIEWED_TRACKED_CHANGE');
    }
    const result = {
        ready: true, alreadyInstalled: head === release, base: head, release,
        packageJsonSha256: digest(git(project, ['show', release + ':package.json'], true)).toUpperCase(),
        packageLockSha256: digest(git(project, ['show', release + ':package-lock.json'], true)).toUpperCase()
    };
    if (result.alreadyInstalled) return result;
    for (const file of manifest.files) {
        const location = fileIn(project, file.path);
        if (!fs.existsSync(location) || !fs.lstatSync(location).isFile()
            || digest(fs.readFileSync(location)) !== file.sha256) fail('SOURCE_CHANGED:' + file.path);
        const existsInIndex = Boolean(git(project, ['ls-files', '--', file.path]).trim());
        if (existsInIndex !== file.tracked) fail('SOURCE_TRACKING_CHANGED:' + file.path);
        git(project, ['cat-file', '-e', release + ':' + file.path]);
    }
    const added = new Set(manifest.files.filter(file => !file.tracked).map(file => file.path));
    for (const file of lines(git(project, ['diff', '--name-only', '--diff-filter=A', '-z', head, release]))) {
        if (fs.existsSync(path.resolve(project, file)) && !added.has(file)) fail('UNREVIEWED_UNTRACKED_COLLISION:' + file);
    }
    return result;
}

function installRelease(options) {
    const { target, manifest } = options;
    const project = fs.realpathSync(options.project);
    const info = inspectRelease({ project, target, manifest });
    if (info.alreadyInstalled) return info;
    const backup = path.resolve(options.backup);
    const backupRelative = path.relative(project, backup);
    const insideProject = !path.isAbsolute(backupRelative) && backupRelative !== '..' && !backupRelative.startsWith('..' + path.sep);
    if (insideProject || fs.existsSync(backup)) fail('INVALID_BACKUP_DIRECTORY');
    fs.mkdirSync(backup, { recursive: true });
    for (const file of manifest.files) {
        const destination = fileIn(path.join(backup, 'files'), file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(fileIn(project, file.path), destination, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(path.join(backup, 'before.json'), JSON.stringify(info, null, 2));
    fs.writeFileSync(path.join(backup, 'tracked.patch'), git(project, ['diff', 'HEAD', '--binary'], true));
    fs.writeFileSync(path.join(backup, 'index.patch'), git(project, ['diff', '--cached', '--binary'], true));
    git(project, ['bundle', 'create', path.join(backup, 'before.bundle'), 'HEAD']);
    // Recheck the live files after copying, before the first destructive operation.
    inspectRelease({ project, target, manifest });
    for (const file of manifest.files.filter(entry => !entry.tracked)) {
        const destination = fileIn(path.join(backup, 'untracked-originals'), file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(fileIn(project, file.path), destination);
    }
    git(project, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...manifest.files.filter(file => file.tracked).map(file => file.path)]);
    git(project, ['merge', '--ff-only', '--no-edit', target]);
    if (git(project, ['rev-parse', 'HEAD']).trim() !== target) fail('INSTALLED_COMMIT_MISMATCH');
    return { ...info, installed: true, backup };
}

async function assertRuntimeStopped(pid) {
    if (!Number.isInteger(pid) || pid <= 0) fail('STOPPED_PID_REQUIRED');
    try { process.kill(pid, 0); fail('OLD_PROCESS_STILL_RUNNING'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: 3000 });
        socket.setTimeout(3000);
        socket.on('connect', () => { socket.destroy(); reject(new Error('PRODUCTION_PORT_IN_USE')); });
        socket.on('timeout', () => { socket.destroy(); reject(new Error('PORT_INSPECTION_INCOMPLETE')); });
        socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('PORT_INSPECTION_INCOMPLETE')));
    });
}

module.exports = { inspectRelease, installRelease };
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const value = name => args[args.indexOf(name) + 1];
        if (!args.includes('--project') || !args.includes('--commit') || !args.includes('--manifest')) fail('RELEASE_ARGUMENTS_REQUIRED');
        const options = { project: value('--project'), target: value('--commit'), manifest: JSON.parse(fs.readFileSync(value('--manifest'), 'utf8')) };
        if (args.includes('--apply')) {
            await assertRuntimeStopped(Number(args.includes('--stopped-pid') ? value('--stopped-pid') : 0));
            if (!args.includes('--backup')) fail('BACKUP_REQUIRED');
            console.log(JSON.stringify(installRelease({ ...options, backup: value('--backup') })));
        } else console.log(JSON.stringify(inspectRelease(options)));
    })().catch(error => {
        // Never include provider sources, environment variables or patch bodies.
        const code = String(error.message || '').split(':')[0];
        console.error(JSON.stringify({ ready: false, code: /^[A-Z_]+$/.test(code) ? code : 'REVIEWED_RELEASE_INSTALL_FAILED' }));
        process.exitCode = 1;
    });
}
