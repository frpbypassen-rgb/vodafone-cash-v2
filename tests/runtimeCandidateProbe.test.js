'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { runPrivateProbe } = require('../scripts/runRuntimeCandidateProbe.cjs');
const fixtures = [];
const servers = [];
const fixture = async (role = 'probe', options = {}) => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ahram-private-probe-test-'),
    );
    fixtures.push(root);
    const source = http.createServer((_req, res) =>
        res.end(
            JSON.stringify({
                status: options.liveStatus || 'ok',
                startupReady: true,
                pid: 919191,
            }),
        ),
    );
    servers.push(source);
    await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(
        path.join(root, 'app.js'),
        `
const fs=require('fs'),http=require('http');
console.log('private-log-secret'); console.log('Probe runtime: background initialization skipped');
http.createServer((req,res)=>{
 fs.appendFileSync('requests.log',req.method+' '+req.url+'\\n');
 if(req.url==='/health/ready'){res.end(JSON.stringify({status:'ok',pid:${options.wrongChildPid ? '919191' : 'process.pid'},startupReady:true,runtimeRole:${JSON.stringify(role)},acceptingMutations:${role !== 'probe'}}));return;}
 if(req.url.startsWith('/socket.io/')){res.statusCode=403;res.end('{}');return;}
 res.statusCode=503;res.end(JSON.stringify({code:'RUNTIME_PROBE_ONLY'}));
}).listen(Number(process.env.PORT),process.env.HTTP_BIND_HOST);
`,
    );
    return {
        root,
        livePort: source.address().port,
        preflight: { nextStepReady: true },
    };
};
afterAll(async () => {
    await Promise.all(
        servers.map(
            (server) => new Promise((resolve) => server.close(resolve)),
        ),
    );
    for (const root of fixtures) {
        const real = fs.realpathSync(root);
        if (
            path.dirname(real).toLowerCase() !==
                fs.realpathSync(os.tmpdir()).toLowerCase() ||
            !path.basename(real).startsWith('ahram-private-probe-test-')
        )
            throw new Error('Unsafe fixture cleanup');
        fs.rmSync(real, { recursive: true, force: true });
    }
});

test('a bounded private child is verified then closed while the serving listener remains available', async () => {
    const f = await fixture();
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: f.preflight,
        livePort: f.livePort,
        startupTimeoutMs: 3000,
    });
    expect(report).toMatchObject({
        result: 'PASS',
        ownedChildStopped: true,
        liveProcessUnchanged: true,
        liveBefore: { pid: 919191 },
        liveAfter: { pid: 919191 },
        role: 'probe',
        acceptingMutations: false,
    });
    expect(report.checks.every((check) => check.status === 503)).toBe(true);
    expect(report.socketStatus).toBe(403);
    expect(JSON.stringify(report)).not.toContain('private-log-secret');
    expect(fs.readFileSync(report.privateLogPath, 'utf8')).toContain(
        'private-log-secret',
    );
}, 15000);

test('no operation request is sent until the child proves probe role and process identity', async () => {
    const f = await fixture('full');
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: f.preflight,
        livePort: f.livePort,
        startupTimeoutMs: 3000,
    });
    expect(report).toMatchObject({
        result: 'FAIL',
        code: 'PROBE_IDENTITY_MISMATCH',
        ownedChildStopped: true,
        liveProcessUnchanged: true,
    });
    expect(
        fs.readFileSync(path.join(f.root, 'requests.log'), 'utf8'),
    ).not.toContain('POST');
}, 15000);

test('failed preflight never starts a child or touches application files', async () => {
    const f = await fixture();
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: { nextStepReady: false },
        livePort: f.livePort,
    });
    expect(report).toMatchObject({
        result: 'BLOCKED',
        code: 'PREFLIGHT_NOT_READY',
        applicationStarted: false,
    });
    expect(fs.existsSync(path.join(f.root, 'requests.log'))).toBe(false);
}, 15000);

test('a different health PID is rejected before sending any operation-shaped request', async () => {
    const f = await fixture('probe', { wrongChildPid: true });
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: f.preflight,
        livePort: f.livePort,
        startupTimeoutMs: 3000,
    });
    expect(report).toMatchObject({
        result: 'FAIL',
        code: 'PROBE_IDENTITY_MISMATCH',
        ownedChildStopped: true,
    });
    expect(
        fs.readFileSync(path.join(f.root, 'requests.log'), 'utf8'),
    ).not.toContain('POST');
}, 15000);

test('degraded live health blocks private startup', async () => {
    const f = await fixture('probe', { liveStatus: 'degraded' });
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: f.preflight,
        livePort: f.livePort,
    });
    expect(report).toMatchObject({
        result: 'BLOCKED',
        code: 'LIVE_NOT_READY',
        applicationStarted: false,
    });
    expect(fs.existsSync(path.join(f.root, 'requests.log'))).toBe(false);
}, 15000);

test('a child that never becomes ready is closed at the bounded deadline', async () => {
    const f = await fixture();
    fs.writeFileSync(path.join(f.root, 'app.js'), 'setInterval(()=>{},1000);');
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: f.preflight,
        livePort: f.livePort,
        startupTimeoutMs: 1000,
    });
    expect(report).toMatchObject({
        result: 'FAIL',
        code: 'PROBE_READY_TIMEOUT',
        ownedChildStopped: true,
        liveProcessUnchanged: true,
    });
}, 15000);

test('a child startup failure is contained and does not restart or terminate the live listener', async () => {
    const f = await fixture();
    fs.writeFileSync(path.join(f.root, 'app.js'), 'process.exit(7);');
    const report = await runPrivateProbe({
        candidate: f.root,
        preflight: f.preflight,
        livePort: f.livePort,
        startupTimeoutMs: 1000,
    });
    expect(report).toMatchObject({
        result: 'FAIL',
        code: 'CANDIDATE_EXITED',
        ownedChildStopped: true,
        liveProcessUnchanged: true,
    });
}, 15000);
