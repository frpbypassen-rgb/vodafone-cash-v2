'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const prepare = path.resolve(
    __dirname,
    '../scripts/prepareRuntimeCandidate.ps1',
);
const fixtures = [];
// This deployment helper targets Windows PowerShell 5 and Windows junction semantics.
const windowsTest = process.platform === 'win32' ? test : test.skip;
const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
const put = (root, file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
};
const fixture = (withLifecycle = false) => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ahram-candidate-test-'),
    );
    fixtures.push(root);
    const source = path.join(root, 'serving');
    fs.mkdirSync(source);
    git(source, 'init', '--quiet');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    put(source, '.gitignore', '.env\nnode_modules/\n');
    put(source, '.env', 'JWT_SECRET=synthetic-fixture-secret\n');
    const pkg = { name: 'candidate-test', version: '1.0.0', private: true };
    if (withLifecycle)
        pkg.scripts = {
            preinstall:
                "node -e \"require('fs').writeFileSync('HOOK_RAN','bad')\"",
        };
    put(source, 'package.json', JSON.stringify(pkg) + '\n');
    put(
        source,
        'package-lock.json',
        JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            lockfileVersion: 3,
            requires: true,
            packages: {
                '': {
                    name: pkg.name,
                    version: pkg.version,
                    ...(withLifecycle ? { hasInstallScript: true } : {}),
                },
            },
        }) + '\n',
    );
    put(source, 'app.js', "'use strict';\n// existing serving code\n");
    put(
        source,
        'routes/executors.js',
        "'use strict';\nconst options={new:true};\n// a\n// b\n// c\n// d\nmodule.exports=options;\n",
    );
    git(source, 'add', '.');
    git(source, 'commit', '--quiet', '-m', 'baseline');
    const original = git(source, 'rev-parse', 'HEAD');
    put(source, 'app.js', "'use strict';\n// runtimeRoleGate(process.env)\n");
    put(source, 'utils/runtimeRole.js', "'use strict';\nmodule.exports={};\n");
    put(
        source,
        'ecosystem.runtime-probe.config.js',
        "'use strict';\nmodule.exports={apps:[]};\n",
    );
    put(
        source,
        'routes/executors.js',
        fs
            .readFileSync(path.join(source, 'routes/executors.js'), 'utf8')
            .replace('new:true', "returnDocument:'after'"),
    );
    git(source, 'add', '.');
    git(source, 'commit', '--quiet', '-m', 'candidate');
    const revision = git(source, 'rev-parse', 'HEAD');
    git(source, 'checkout', '--quiet', '--detach', original);
    return {
        root,
        source,
        original,
        revision,
        target: path.join(root, 'candidate'),
    };
};
const run = (f, target = f.target, skipInstall = true) =>
    spawnSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            prepare,
            '-ProjectPath',
            f.source,
            '-Revision',
            f.revision,
            '-DestinationPath',
            target,
            ...(skipInstall ? ['-SkipDependencyInstall'] : []),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 45000 },
    );
afterAll(() => {
    for (const root of fixtures) {
        const absolute = fs.realpathSync(root);
        if (
            path.dirname(absolute).toLowerCase() !==
                fs.realpathSync(os.tmpdir()).toLowerCase() ||
            !path.basename(absolute).startsWith('ahram-candidate-test-')
        )
            throw new Error(
                'Refusing fixture cleanup outside temporary test root',
            );
        fs.rmSync(absolute, { recursive: true, force: true });
    }
});

windowsTest(
    'preparation preserves serving files and merges local API commission into an independent candidate',
    () => {
        const f = fixture();
        const localRoute =
            fs.readFileSync(
                path.join(f.source, 'routes/executors.js'),
                'utf8',
            ) + '// local commission route\n';
        put(f.source, 'routes/executors.js', localRoute);
        put(
            f.source,
            'services/apiProfitCommissionService.js',
            "'use strict';\nmodule.exports={fixture:true};\n",
        );
        const before = git(f.source, 'status', '--porcelain');
        const result = run(f);
        expect({ status: result.status, error: result.stderr }).toEqual({
            status: 0,
            error: '',
        });
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({
            prepared: true,
            sourceFilesUnchanged: true,
            processesChanged: false,
            dependencyLifecycleHooksRun: false,
        });
        expect(git(f.source, 'status', '--porcelain')).toBe(before);
        expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.original);
        expect(
            fs.readFileSync(path.join(f.source, 'routes/executors.js'), 'utf8'),
        ).toBe(localRoute);
        const merged = fs.readFileSync(
            path.join(f.target, 'routes/executors.js'),
            'utf8',
        );
        expect(merged).toContain("returnDocument:'after'");
        expect(merged).toContain('local commission route');
        expect(fs.readFileSync(path.join(f.target, '.env'), 'utf8')).toContain(
            'synthetic-fixture-secret',
        );
        expect(result.stdout + result.stderr).not.toContain(
            'synthetic-fixture-secret',
        );
        expect(
            fs.existsSync(
                path.join(f.target, 'services/apiProfitCommissionService.js'),
            ),
        ).toBe(true);
    },
    60000,
);

windowsTest(
    'an unchanged source can also be prepared without Compare-Object null binding failure',
    () => {
        const f = fixture();
        const result = run(f);
        expect({ status: result.status, error: result.stderr }).toEqual({
            status: 0,
            error: '',
        });
    },
    60000,
);

windowsTest(
    'an unexpected source modification aborts before creating a candidate',
    () => {
        const f = fixture();
        put(f.source, 'app.js', '/* unexpected live edit */\n');
        expect(run(f).status).not.toBe(0);
        expect(fs.existsSync(f.target)).toBe(false);
    },
    60000,
);

windowsTest(
    'a destination inside the serving tree or an existing directory is refused',
    () => {
        const f = fixture();
        const inside = path.join(f.source, 'candidate');
        expect(run(f, inside).status).not.toBe(0);
        expect(fs.existsSync(inside)).toBe(false);
        fs.mkdirSync(f.target);
        put(f.target, 'keep.txt', 'keep');
        expect(run(f).status).not.toBe(0);
        expect(fs.readFileSync(path.join(f.target, 'keep.txt'), 'utf8')).toBe(
            'keep',
        );
    },
    60000,
);

windowsTest(
    'a merge conflict remains isolated and cannot overwrite the serving route',
    () => {
        const f = fixture();
        const edited = fs
            .readFileSync(path.join(f.source, 'routes/executors.js'), 'utf8')
            .replace('new:true', "new:'local-conflict'");
        put(f.source, 'routes/executors.js', edited);
        const result = run(f);
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain('"prepared":  true');
        expect(
            fs.readFileSync(path.join(f.source, 'routes/executors.js'), 'utf8'),
        ).toBe(edited);
        expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.original);
    },
    60000,
);

windowsTest(
    'a junction ancestor cannot disguise a destination inside the serving tree',
    () => {
        const f = fixture();
        fs.mkdirSync(path.join(f.source, 'subparent'));
        const alias = path.join(f.root, 'alias');
        fs.symlinkSync(f.source, alias, 'junction');
        const result = run(f, path.join(alias, 'subparent', 'candidate'));
        expect(result.status).not.toBe(0);
        expect(
            fs.existsSync(path.join(f.source, 'subparent', 'candidate')),
        ).toBe(false);
    },
    60000,
);

windowsTest(
    'candidate dependency installation cannot run package lifecycle hooks',
    () => {
        const f = fixture(true);
        const result = run(f, f.target, false);
        expect({ status: result.status, error: result.stderr }).toEqual({
            status: 0,
            error: '',
        });
        expect(JSON.parse(result.stdout)).toMatchObject({
            dependenciesInstalled: true,
            dependencyLifecycleHooksRun: false,
        });
        expect(fs.existsSync(path.join(f.target, 'HOOK_RAN'))).toBe(false);
        expect(fs.existsSync(path.join(f.source, 'HOOK_RAN'))).toBe(false);
    },
    60000,
);
