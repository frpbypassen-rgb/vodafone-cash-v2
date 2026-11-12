'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inspectRelease } = require('./installReviewedServerRelease.cjs');
const git = (project, args) => execFileSync('git', ['-C', project, ...args], { windowsHide: true });

function prepareCleanRelease({ project, target }) {
    project = fs.realpathSync(project);
    git(project, ['diff', '--quiet', '--ignore-submodules=all', 'HEAD', '--']);
    const baseCommit = git(project, ['rev-parse', 'HEAD']).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(target || '')) throw new Error('INVALID_RELEASE_COMMIT');
    for (const file of ['package.json', 'package-lock.json']) {
        if (!git(project, ['show', baseCommit + ':' + file]).equals(git(project, ['show', target + ':' + file]))) {
            throw new Error('SOURCE_ONLY_DEPENDENCIES_CHANGED');
        }
    }
    const file = 'models/ExecutorGroup.js';
    const manifest = { baseCommit, files: [{ path: file, tracked: true,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, file))).digest('hex') }] };
    inspectRelease({ project, target, manifest });
    return manifest;
}

module.exports = { prepareCleanRelease };
if (require.main === module) {
    const value = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1]; };
    try {
        const project = value('--project'), target = value('--commit'), output = value('--output');
        if (!project || !output) throw new Error('ARGUMENTS_REQUIRED');
        const manifest = prepareCleanRelease({ project, target });
        fs.writeFileSync(output, JSON.stringify(manifest, null, 2), { flag: 'wx' });
        console.log('CLEAN_SOURCE_MANIFEST_READY');
    } catch (_) {
        console.error('CLEAN_SOURCE_PREPARATION_FAILED: verify tracked changes, release and dependency manifests.');
        process.exitCode = 1;
    }
}
