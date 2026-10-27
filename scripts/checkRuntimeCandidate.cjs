'use strict';
// Preflight only: never imports application routes/models/services or opens DB/Redis connections.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const BASE_REVISION = 'f587e44c84f9ca3583b4a11c537f2f8ef0ebedd3';
const SESSION_BASE_BLOB = 'ede6b471bcfe94d7bc47a6d0702eb972b58a4bb2';
const SESSION_PROBE_BLOB = 'ab9f684637f3d765bf54116e3da6802787894079';
const git = (root, ...args) =>
    execFileSync('git', ['-C', root, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
const blobId = (body) =>
    crypto
        .createHash('sha1')
        .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
        .digest('hex');
const normalize = (body) =>
    Buffer.from(body.toString('utf8').replace(/\r\n/g, '\n'));
const separateRoots = (candidate, source) => {
    const a = fs.realpathSync(candidate),
        b = fs.realpathSync(source);
    const inside = (parent, child) => {
        const relative = path.relative(parent, child);
        return (
            !relative ||
            (relative !== '..' &&
                !relative.startsWith('..' + path.sep) &&
                !path.isAbsolute(relative))
        );
    };
    if (inside(a, b) || inside(b, a))
        throw new Error('CANDIDATE_MUST_BE_SEPARATE');
    return { candidate: a, source: b };
};
const applyProbeSessionFix = (candidate, source) => {
    ({ candidate, source } = separateRoots(candidate, source));
    const file = path.join(candidate, 'config/sessionStore.js');
    if (
        fs.lstatSync(file).isSymbolicLink() ||
        fs.realpathSync(path.dirname(file)) !== path.join(candidate, 'config')
    )
        throw new Error('UNEXPECTED_SESSION_STORE_PATH');
    const current = blobId(normalize(fs.readFileSync(file)));
    if (current === SESSION_PROBE_BLOB) return 'ALREADY_APPLIED';
    if (current !== SESSION_BASE_BLOB)
        throw new Error('UNEXPECTED_SESSION_STORE_CONTENT');
    const replacement = git(source, 'show', SESSION_PROBE_BLOB);
    if (blobId(replacement) !== SESSION_PROBE_BLOB)
        throw new Error('SESSION_STORE_BLOB_MISMATCH');
    fs.writeFileSync(file, replacement);
    return 'APPLIED_TO_CANDIDATE';
};

const resolveRuntimeImport = (candidate, file, specifier) => {
    const fileRequire = createRequire(path.join(candidate, file));
    let resolved;
    try {
        resolved = fileRequire.resolve(specifier);
    } catch (error) {
        // app.js registers ts-node before loading routes. Resolve TS without executing/registering it here.
        if (
            error.code !== 'MODULE_NOT_FOUND' ||
            !/^\.\.?\//.test(specifier) ||
            path.extname(specifier)
        )
            throw error;
        for (const suffix of ['.ts', '/index.ts']) {
            try {
                resolved = fileRequire.resolve(specifier + suffix);
                break;
            } catch {
                /* Try the next supported TS entry. */
            }
        }
        if (!resolved) throw error;
    }
    if (!path.isAbsolute(resolved)) return resolved;
    const relative = path.relative(candidate, resolved);
    const first = relative.split(path.sep)[0];
    if (
        ![
            'node_modules',
            'models',
            'utils',
            'services',
            'middlewares',
            'config',
            'controllers',
            'routes',
            'src',
        ].includes(first)
    )
        throw new Error('IMPORT_OUTSIDE_RUNTIME_MODULES');
    return resolved;
};

const repairCanvasArtifacts = (candidate, source) => {
    if (process.platform !== 'win32')
        throw new Error('CANVAS_REPAIR_WINDOWS_ONLY');
    ({ candidate, source } = separateRoots(candidate, source));
    const from = path.join(source, 'node_modules/canvas');
    const to = path.join(candidate, 'node_modules/canvas');
    if (!fs.existsSync(path.join(from, 'package.json')))
        throw new Error('CANVAS_SOURCE_NOT_INSTALLED');
    const regular = (file) => {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('CANVAS_ARTIFACT_PATH_UNSAFE');
        return fs.readFileSync(file);
    };
    if (fs.realpathSync(from) !== from || fs.realpathSync(to) !== to)
        throw new Error('CANVAS_ARTIFACT_PATH_UNSAFE');
    const a = JSON.parse(regular(path.join(from, 'package.json')));
    const b = JSON.parse(regular(path.join(to, 'package.json')));
    if (a.name !== 'canvas' || b.name !== 'canvas' || a.version !== b.version)
        throw new Error('CANVAS_VERSION_OR_SOURCE_MISMATCH');
    for (const file of ['index.js', 'lib/bindings.js']) {
        if (
            !regular(path.join(from, file)).equals(regular(path.join(to, file)))
        )
            throw new Error('CANVAS_VERSION_OR_SOURCE_MISMATCH');
    }
    try {
        const sourceCanvas = createRequire(path.join(source, 'package.json'))(
            'canvas',
        );
        if (!sourceCanvas.createCanvas(1, 1).toBuffer('image/png').length)
            throw new Error('CANVAS_SOURCE_NATIVE_CHECK_FAILED');
    } catch {
        throw new Error('CANVAS_SOURCE_NATIVE_UNAVAILABLE');
    }
    const sourceRelease = path.join(from, 'build/Release');
    const targetRelease = path.join(to, 'build/Release');
    if (fs.realpathSync(sourceRelease) !== sourceRelease)
        throw new Error('CANVAS_ARTIFACT_PATH_UNSAFE');
    if (
        fs.existsSync(path.join(to, 'build')) &&
        fs.realpathSync(path.join(to, 'build')) !== path.join(to, 'build')
    )
        throw new Error('CANVAS_ARTIFACT_PATH_UNSAFE');
    if (
        fs.existsSync(targetRelease) &&
        fs.realpathSync(targetRelease) !== targetRelease
    )
        throw new Error('CANVAS_ARTIFACT_PATH_UNSAFE');
    const files = fs
        .readdirSync(sourceRelease)
        .filter((file) => /\.(?:node|dll)$/i.test(file));
    if (!files.includes('canvas.node'))
        throw new Error('CANVAS_SOURCE_NATIVE_MISSING');
    const snapshots = new Map();
    // Validate all files before copying anything; existing conflicting binaries are never replaced.
    for (const file of files) {
        const bytes = regular(path.join(sourceRelease, file));
        snapshots.set(file, bytes);
        const destination = path.join(targetRelease, file);
        if (fs.existsSync(destination) && !regular(destination).equals(bytes))
            throw new Error('CANVAS_TARGET_ARTIFACT_CONFLICT');
    }
    fs.mkdirSync(targetRelease, { recursive: true });
    let copied = 0;
    for (const [file, bytes] of snapshots) {
        const destination = path.join(targetRelease, file);
        if (!fs.existsSync(destination)) {
            fs.copyFileSync(
                path.join(sourceRelease, file),
                destination,
                fs.constants.COPYFILE_EXCL,
            );
            copied++;
        }
        if (
            !regular(destination).equals(bytes) ||
            !regular(path.join(sourceRelease, file)).equals(bytes)
        )
            throw new Error('CANVAS_ARTIFACT_VERIFICATION_FAILED');
    }
    return {
        status: 'COPIED_VERIFIED_NATIVE_ARTIFACTS',
        version: a.version,
        copiedFiles: copied,
        sourceUnchanged: true,
    };
};

const inspectModuleLoad = (source, ts, resolveRequire) => {
    const file = ts.createSourceFile(
        'candidate.js',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    if (file.parseDiagnostics.length) return [{ code: 'PARSE_ERROR' }];
    const issues = [];
    const names = new Set([
        'require',
        'express.Router',
        'mongoose.model',
        'Object.freeze',
        'Number',
        'String',
        'Boolean',
        'parseInt',
        'parseFloat',
        'Date.now',
        // Existing executor route upload middleware registration; does not process a request.
        'multer',
        'multer.memoryStorage',
        'adminDepositUpload.array',
    ]);
    const constructors = new Set([
        'Map',
        'Set',
        'Date',
        'RegExp',
        'mongoose.Schema',
        'Schema',
    ]);
    const safeName = (node) => {
        const text = node.getText(file);
        return /^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(text)
            ? text
            : 'expression';
    };
    const visit = (node) => {
        // Declaring callbacks/functions does not execute their bodies. An IIFE's outer call is still checked.
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node)) {
            const name = safeName(node.expression);
            let code;
            if (
                name === 'require' &&
                (node.arguments.length !== 1 ||
                    !ts.isStringLiteral(node.arguments[0]))
            )
                code = 'DYNAMIC_REQUIRE';
            else if (name === 'require' && resolveRequire) {
                try {
                    resolveRequire(node.arguments[0].text);
                } catch {
                    code = 'UNRESOLVED_REQUIRE';
                }
            } else if (
                !names.has(name) &&
                !/^router\.(?:get|post|put|patch|delete|use|all|param)$/.test(
                    name,
                ) &&
                !/^[a-zA-Z_$][\w$]*Schema\.index$/.test(name) &&
                name !== 'schema.index'
            )
                code = 'UNREVIEWED_TOP_LEVEL_CALL';
            if (code)
                issues.push({
                    code,
                    call: name,
                    line:
                        file.getLineAndCharacterOfPosition(node.getStart(file))
                            .line + 1,
                });
        }
        if (
            ts.isNewExpression(node) &&
            !constructors.has(safeName(node.expression))
        )
            issues.push({
                code: 'UNREVIEWED_TOP_LEVEL_CONSTRUCTOR',
                call: safeName(node.expression),
                line:
                    file.getLineAndCharacterOfPosition(node.getStart(file))
                        .line + 1,
            });
        ts.forEachChild(node, visit);
    };
    visit(file);
    return issues;
};

const inspectPackages = (load) => {
    const result = {};
    for (const name of [
        'bcrypt',
        'canvas',
        'ts-node',
        'typescript',
        'mongoose',
        'connect-mongo',
        'express-rate-limit',
        'socket.io',
        'ioredis',
    ]) {
        try {
            const module = load(name);
            if (
                name === 'bcrypt' &&
                !module.compareSync(
                    'synthetic-probe',
                    module.hashSync('synthetic-probe', 4),
                )
            )
                throw new Error('NATIVE_CHECK_FAILED');
            if (
                name === 'canvas' &&
                !module.createCanvas(1, 1).toBuffer('image/png').length
            )
                throw new Error('NATIVE_CHECK_FAILED');
            result[name] = { ok: true };
        } catch (error) {
            result[name] = {
                ok: false,
                code: ['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(
                    error.code,
                )
                    ? error.code
                    : 'DEPENDENCY_CHECK_FAILED',
            };
        }
    }
    return result;
};

const readLiveHealth = () =>
    new Promise((resolve) => {
        const req = http.get(
            'http://127.0.0.1:3000/health/ready',
            { timeout: 5000 },
            (res) => {
                let body = '';
                res.on('data', (part) => {
                    if (body.length < 65536) body += part;
                });
                res.on('end', () => {
                    try {
                        const value = JSON.parse(body);
                        resolve({
                            reachable: true,
                            status: value.status,
                            pid: value.pid,
                            startupReady: value.startupReady,
                        });
                        res.on('error', () => resolve({ reachable: false }));
                    } catch {
                        resolve({
                            reachable: true,
                            validHealthResponse: false,
                        });
                    }
                });
            },
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve({ reachable: false }));
    });

const main = async () => {
    const argument = (key) => {
        const index = process.argv.indexOf(key);
        if (index < 0 || !process.argv[index + 1])
            throw new Error('ARGUMENT_REQUIRED');
        return process.argv[index + 1];
    };
    const roots = separateRoots(argument('--candidate'), argument('--source'));
    const { candidate, source } = roots;
    if (git(candidate, 'rev-parse', 'HEAD').toString().trim() !== BASE_REVISION)
        throw new Error('UNEXPECTED_CANDIDATE_REVISION');
    const trustedFiles = [
        'app.js',
        'utils/runtimeRole.js',
        'config/securityPolicy.js',
        'config/database.js',
        'config/redis.js',
        'ecosystem.runtime-probe.config.js',
    ];
    if (git(candidate, 'diff', 'HEAD', '--', ...trustedFiles).length)
        throw new Error('CANDIDATE_BOOTSTRAP_MODIFIED');
    const localFiles = [
        'models/ApiBalanceAudit.js',
        'models/ExecutorGroup.js',
        'routes/executors.js',
        'services/apiProviderReconciliationService.js',
        'views/api_room.ejs',
        'services/apiProfitCommissionService.js',
        'utils/apiProfitCommission.js',
        'views/partials/api_profit_commission.ejs',
    ];
    const changed = git(candidate, 'diff', '--name-only', 'HEAD', '--')
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    if (
        changed.some(
            (name) =>
                !localFiles.includes(name) && name !== 'config/sessionStore.js',
        )
    )
        throw new Error('UNEXPECTED_CANDIDATE_CHANGE');
    const untracked = git(
        candidate,
        'ls-files',
        '--others',
        '--exclude-standard',
    )
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    if (
        untracked.some(
            (name) =>
                /^(services|utils|views|routes|models|controllers|config)\//.test(
                    name,
                ) && !localFiles.includes(name),
        )
    )
        throw new Error('UNREVIEWED_CANDIDATE_RUNTIME_FILE');
    const environmentFileMatchesSource = fs
        .readFileSync(path.join(candidate, '.env'))
        .equals(fs.readFileSync(path.join(source, '.env')));
    if (!environmentFileMatchesSource)
        throw new Error('CANDIDATE_ENV_DIFFERS_FROM_SOURCE');
    const sessionStoreFix = applyProbeSessionFix(candidate, source);
    const load = createRequire(path.join(candidate, 'package.json'));
    let dependencies = inspectPackages(load);
    let canvasRepair;
    if (process.argv.includes('--repair-canvas') && !dependencies.canvas.ok) {
        canvasRepair = repairCanvasArtifacts(candidate, source);
        dependencies = inspectPackages(load);
    }
    const moduleReview = [];
    if (dependencies.typescript.ok) {
        const ts = load('typescript');
        for (const file of localFiles.filter(
            (name) =>
                name.endsWith('.js') &&
                fs.existsSync(path.join(candidate, name)),
        )) {
            const issues = inspectModuleLoad(
                fs.readFileSync(path.join(candidate, file), 'utf8'),
                ts,
                (specifier) => resolveRuntimeImport(candidate, file, specifier),
            );
            if (issues.length) moduleReview.push({ file, issues });
        }
    } else
        moduleReview.push({ code: 'TYPESCRIPT_UNAVAILABLE_FOR_STATIC_REVIEW' });
    const parsed = load('dotenv').parse(
        fs.readFileSync(path.join(candidate, '.env')),
    );
    const env = {
        ...parsed,
        ...process.env,
        NODE_ENV: 'production',
        RUNTIME_ROLE: 'probe',
        HTTP_BIND_HOST: '127.0.0.1',
        REDIS_REQUIRED: 'true',
    };
    const policy = load(
        './config/securityPolicy.js',
    ).validateProductionSecurityEnv(env);
    const liveHealth = await readLiveHealth();
    const allDependenciesReady = Object.values(dependencies).every(
        (item) => item.ok,
    );
    process.stdout.write(
        JSON.stringify(
            {
                timestampUtc: new Date().toISOString(),
                candidatePath: candidate,
                preflightOnly: true,
                applicationStarted: false,
                liveProcessesChanged: false,
                environmentFileMatchesSource,
                sessionStoreFix,
                dependencies,
                canvasRepair,
                productionEnvironment: {
                    valid: policy.valid,
                    errors: policy.errors,
                },
                moduleLoadReview: moduleReview,
                liveHealth,
                nextStepReady:
                    allDependenciesReady &&
                    policy.valid &&
                    moduleReview.length === 0 &&
                    liveHealth.status === 'ok',
                note: 'Static checks do not prove absence of all import side effects. No public routing or worker handoff is authorized by this report.',
            },
            null,
            2,
        ) + '\n',
    );
};

module.exports = {
    inspectModuleLoad,
    inspectPackages,
    applyProbeSessionFix,
    resolveRuntimeImport,
    repairCanvasArtifacts,
};
if (require.main === module)
    main().catch((error) => {
        const safe =
            /^(?:ARGUMENT_REQUIRED|CANDIDATE_MUST_BE_SEPARATE|UNEXPECTED_[A-Z_]+|CANDIDATE_[A-Z_]+|CANVAS_[A-Z_]+|UNREVIEWED_[A-Z_]+|SESSION_STORE_BLOB_MISMATCH)$/.test(
                error.message,
            )
                ? error.message
                : 'PREFLIGHT_FAILED';
        process.stderr.write(
            JSON.stringify({
                preflightOnly: true,
                applicationStarted: false,
                code: safe,
            }) + '\n',
        );
        process.exitCode = 1;
    });
