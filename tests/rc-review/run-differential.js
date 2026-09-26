'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { diffSnapshots } = require('./diffSnapshots');

const mongoBase = fs.readFileSync('/tmp/rc-mongo-uri.txt', 'utf8').trim().replace(/\/?(\?|$)/, '/$1');
const base = mongoBase.includes('?')
    ? mongoBase.replace('/?', '/DBNAME?')
    : `${mongoBase.replace(/\/$/, '')}/DBNAME`;

const uriFor = (name) => base.replace('DBNAME', name);
const runner = path.join(__dirname, 'run-target.js');

const runOne = (label, targetRoot, sha, dbName, redisDb, outFile) => {
    const env = {
        ...process.env,
        RC_TARGET: targetRoot,
        RC_SHA: sha,
        RC_LABEL: label,
        RC_MONGO_URI: uriFor(dbName),
        RC_REDIS_URL: `redis://127.0.0.1:6379/${redisDb}`,
        RC_OUT: outFile,
        NODE_ENV: 'production'
    };
    delete env.APP_ENV;
    delete env.ENVIRONMENT;
    delete env.EXTERNAL_API_ENABLED;
    delete env.BULLMQ_WORKERS_ENABLED;
    delete env.FINANCIAL_SCHEDULERS_ENABLED;
    delete env.MERCHANT_WEBHOOK_WORKER_ENABLED;
    const result = spawnSync(process.execPath, [runner], {
        cwd: targetRoot,
        env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 180000
    });
    return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr
    };
};

const main = () => {
    const outDir = '/tmp/rc-review';
    fs.mkdirSync(outDir, { recursive: true });
    const mainOut = path.join(outDir, 'main.json');
    const rcOut = path.join(outDir, 'rc.json');
    const mainRun = runOne('main', '/tmp/main-dd152b76', 'dd152b763699dfcbb283c3aa16b5a66d8a493681', 'rc_review_main', 1, mainOut);
    const rcRun = runOne('rc', '/workspace', process.env.RC_SHA || '', 'rc_review_rc', 2, rcOut);
    fs.writeFileSync(path.join(outDir, 'main.run.txt'), `${mainRun.stdout}\n---stderr---\n${mainRun.stderr}`);
    fs.writeFileSync(path.join(outDir, 'rc.run.txt'), `${rcRun.stdout}\n---stderr---\n${rcRun.stderr}`);
    if (mainRun.status !== 0 || rcRun.status !== 0) {
        console.error('differential process failed', { main: mainRun.status, rc: rcRun.status });
        console.error(mainRun.stderr.slice(-4000));
        console.error(rcRun.stderr.slice(-4000));
        process.exit(1);
    }
    const mainDoc = JSON.parse(fs.readFileSync(mainOut, 'utf8'));
    const rcDoc = JSON.parse(fs.readFileSync(rcOut, 'utf8'));
    const perScenario = {};
    const names = new Set([...Object.keys(mainDoc.checkpoints), ...Object.keys(rcDoc.checkpoints)]);
    names.forEach((name) => {
        const left = mainDoc.checkpoints[name] || {};
        const right = rcDoc.checkpoints[name] || {};
        perScenario[name] = {
            mainOk: left.ok === true,
            rcOk: right.ok === true,
            mainError: left.error || null,
            rcError: right.error || null,
            mainProviderPayments: left.providerPayments,
            rcProviderPayments: right.providerPayments,
            mainDetail: left.detail || null,
            rcDetail: right.detail || null,
            financialDiffs: diffSnapshots(left.snapshot && left.snapshot.financial, right.snapshot && right.snapshot.financial),
            nonFinancialDiffs: diffSnapshots(left.snapshot && left.snapshot.nonFinancial, right.snapshot && right.snapshot.nonFinancial)
        };
    });
    const report = {
        mainSha: mainDoc.sha,
        rcSha: rcDoc.sha,
        mongo: { main: mainDoc.mongo, rc: rcDoc.mongo },
        finalFinancialDiffs: diffSnapshots(mainDoc.finalSnapshot.financial, rcDoc.finalSnapshot.financial),
        finalNonFinancialDiffs: diffSnapshots(mainDoc.finalSnapshot.nonFinancial, rcDoc.finalSnapshot.nonFinancial),
        perScenario
    };
    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    fs.writeFileSync('/opt/cursor/artifacts/rc_financial_diff.json', JSON.stringify(report, null, 2));
    const summary = {
        finalDiffCount: report.finalFinancialDiffs.length,
        nonFinancialDiffCount: report.finalNonFinancialDiffs.length,
        scenarios: Object.fromEntries(Object.entries(perScenario).map(([name, row]) => [name, {
            mainOk: row.mainOk,
            rcOk: row.rcOk,
            diffs: row.financialDiffs.length,
            mainError: row.mainError && String(row.mainError).split('\n')[0],
            rcError: row.rcError && String(row.rcError).split('\n')[0]
        }]))
    };
    console.log(JSON.stringify(summary, null, 2));
};

main();
