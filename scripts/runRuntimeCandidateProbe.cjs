'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (port, url, method = 'GET') =>
    new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: url, method, timeout: 2000 },
            (res) => {
                let body = '';
                res.on('data', (part) => {
                    if (body.length < 65536) body += part;
                });
                res.on('error', reject);
                res.on('end', () => {
                    let json;
                    try {
                        json = JSON.parse(body);
                    } catch {
                        /* Non-JSON is rejected by the checks. */
                    }
                    resolve({ status: res.statusCode, json });
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
        req.end();
    });
const health = async (port) => {
    try {
        const h = await call(port, '/health/ready');
        return {
            reachable: true,
            status: h.json?.status,
            pid: h.json?.pid,
            startupReady: h.json?.startupReady,
        };
    } catch {
        return { reachable: false };
    }
};
const reservePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
};
const stopOwnedChild = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    const wait = async (milliseconds) => {
        let timer;
        const ended = await Promise.race([
            new Promise((resolve) => child.once('exit', () => resolve(true))),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), milliseconds);
            }),
        ]);
        clearTimeout(timer);
        return ended;
    };
    // The ChildProcess handle identifies only the process created by this runner. Never kill by a supplied PID.
    const ended = wait(3000);
    child.kill('SIGTERM');
    if (await ended) return true;
    const forced = wait(2000);
    child.kill('SIGKILL');
    return forced;
};

const runPrivateProbe = async ({
    candidate,
    preflight,
    livePort = 3000,
    startupTimeoutMs = 60000,
    environment = {},
}) => {
    if (preflight?.nextStepReady !== true)
        return {
            result: 'BLOCKED',
            code: 'PREFLIGHT_NOT_READY',
            applicationStarted: false,
        };
    const liveBefore = await health(livePort);
    if (
        liveBefore.status !== 'ok' ||
        liveBefore.startupReady !== true ||
        !Number.isInteger(liveBefore.pid)
    )
        return {
            result: 'BLOCKED',
            code: 'LIVE_NOT_READY',
            applicationStarted: false,
            liveBefore,
        };
    const port = await reservePort();
    const logDirectory = path.join(candidate, 'logs');
    if (
        fs.existsSync(logDirectory) &&
        fs.realpathSync(logDirectory) !== logDirectory
    )
        throw new Error('UNSAFE_LOG_PATH');
    fs.mkdirSync(logDirectory, { recursive: true });
    const privateLogPath = path.join(
        logDirectory,
        `private-probe-${crypto.randomBytes(8).toString('hex')}.log`,
    );
    const env = {
        ...process.env,
        ...environment,
        NODE_ENV: 'production',
        RUNTIME_ROLE: 'probe',
        HTTP_BIND_HOST: '127.0.0.1',
        PORT: String(port),
        DOTENV_CONFIG_PATH: path.join(candidate, '.env'),
        APP_INSTANCE_COUNT: '2',
        REDIS_REQUIRED: 'true',
        BULLMQ_WORKERS_ENABLED: 'false',
        FINANCIAL_SCHEDULERS_ENABLED: 'false',
        MERCHANT_WEBHOOK_WORKER_ENABLED: 'false',
        EXTERNAL_API_ENABLED: 'false',
        AGENT_REPORT_EMAIL_ENABLED: 'false',
        COMPANY_REPORT_EMAIL_ENABLED: 'false',
        SENTRY_DSN: '',
        LOG_LEVEL: 'info',
        NODE_OPTIONS: '',
        NODE_PATH: '',
    };
    const child = spawn(process.execPath, ['app.js'], {
        cwd: candidate,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
        spawnFailed = false,
        interrupted = false;
    const capture = (part) => {
        if (output.length < 131072) output += part.toString();
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => {
        spawnFailed = true;
    });
    const interrupt = () => {
        interrupted = true;
        child.kill('SIGTERM');
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const report = {
        result: 'FAIL',
        timestampUtc: new Date().toISOString(),
        applicationStarted: true,
        privatePort: port,
        childPid: child.pid,
        privateLogPath,
        liveBefore,
        checks: [],
    };
    try {
        let ready;
        const deadline =
            Date.now() + Math.min(60000, Math.max(1000, startupTimeoutMs));
        while (Date.now() < deadline) {
            if (interrupted) throw new Error('PROBE_INTERRUPTED');
            if (
                spawnFailed ||
                child.exitCode !== null ||
                child.signalCode !== null
            )
                throw new Error('CANDIDATE_EXITED');
            try {
                const h = await call(port, '/health/ready');
                if (h.status === 200) {
                    ready = h.json;
                    break;
                }
            } catch {
                /* Only our reserved loopback port is polled. */
            }
            await delay(200);
        }
        if (!ready) throw new Error('PROBE_READY_TIMEOUT');
        // No operation-shaped request is sent before the owned process proves its isolation mode.
        if (
            ready.pid !== child.pid ||
            ready.runtimeRole !== 'probe' ||
            ready.acceptingMutations !== false
        )
            throw new Error('PROBE_IDENTITY_MISMATCH');
        report.role = ready.runtimeRole;
        report.acceptingMutations = ready.acceptingMutations;
        report.dependencies = {
            db: ready.db,
            redis: ready.redis,
            sessionStore: ready.sessionStore,
        };
        for (const [url, method] of [
            ['/api/v1/merchant/transfer', 'POST'],
            ['/api/mobile/refresh-token', 'POST'],
            ['/login', 'POST'],
            ['/executor/test', 'GET'],
        ]) {
            const response = await call(port, url, method);
            if (
                response.status !== 503 ||
                response.json?.code !== 'RUNTIME_PROBE_ONLY'
            )
                throw new Error('PROBE_GATE_NOT_ENFORCED');
            report.checks.push({ url, method, status: response.status });
        }
        const socket = await call(port, '/socket.io/?EIO=4&transport=polling');
        report.socketStatus = socket.status;
        if (socket.status !== 403) throw new Error('PROBE_SOCKET_NOT_BLOCKED');
        // Give the logger time to flush its bootstrap message into the captured pipe.
        await delay(100);
        if (
            !output.includes('Probe runtime: background initialization skipped')
        )
            throw new Error('BACKGROUND_SKIP_NOT_CONFIRMED');
        report.backgroundInitializationSkipped = true;
        report.result = 'PASS';
    } catch (error) {
        report.code =
            /^(?:PROBE_[A-Z_]+|CANDIDATE_EXITED|BACKGROUND_SKIP_NOT_CONFIRMED)$/.test(
                error.message,
            )
                ? error.message
                : 'PROBE_CHECK_FAILED';
    } finally {
        report.ownedChildStopped = await stopOwnedChild(child);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        fs.writeFileSync(privateLogPath, output, { flag: 'wx', mode: 0o600 });
        report.liveAfter = await health(livePort);
        report.liveProcessUnchanged =
            report.liveAfter.status === 'ok' &&
            report.liveAfter.startupReady === true &&
            report.liveAfter.pid === liveBefore.pid;
        if (!report.ownedChildStopped || !report.liveProcessUnchanged) {
            report.result = 'FAIL';
            report.code = !report.ownedChildStopped
                ? 'PROBE_CLEANUP_FAILED'
                : 'LIVE_PROCESS_CHANGED_OR_NOT_READY';
        }
    }
    return report;
};

const main = async () => {
    const argument = (key) => {
        const index = process.argv.indexOf(key);
        if (index < 0 || !process.argv[index + 1])
            throw new Error('ARGUMENT_REQUIRED');
        return fs.realpathSync(process.argv[index + 1]);
    };
    const candidate = argument('--candidate'),
        source = argument('--source'),
        preflightScript = argument('--preflight-script');
    const normalize = (value) =>
        value
            .toString()
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .trimEnd();
    const trusted = execFileSync(
        'git',
        ['-C', source, 'show', 'ae01788:scripts/checkRuntimeCandidate.cjs'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    if (normalize(fs.readFileSync(preflightScript)) !== normalize(trusted))
        throw new Error('PREFLIGHT_SCRIPT_MISMATCH');
    const preflight = JSON.parse(
        execFileSync(
            process.execPath,
            [preflightScript, '--candidate', candidate, '--source', source],
            {
                encoding: 'utf8',
                timeout: 30000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
            },
        ),
    );
    const report = await runPrivateProbe({ candidate, preflight });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.result !== 'PASS') process.exitCode = 1;
};
module.exports = { runPrivateProbe };
if (require.main === module)
    main().catch((error) => {
        const code = [
            'ARGUMENT_REQUIRED',
            'PREFLIGHT_SCRIPT_MISMATCH',
            'UNSAFE_LOG_PATH',
        ].includes(error.message)
            ? error.message
            : 'PRIVATE_PROBE_RUNNER_FAILED';
        process.stderr.write(
            JSON.stringify({
                result: 'FAIL',
                code,
                publicRoutingChanged: false,
            }) + '\n',
        );
        process.exitCode = 1;
    });
