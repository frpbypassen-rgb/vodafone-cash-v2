'use strict';
const ts = require('typescript');
const {
    inspectModuleLoad,
    inspectPackages,
    applyProbeSessionFix,
    resolveRuntimeImport,
    repairCanvasArtifacts,
} = require('../scripts/checkRuntimeCandidate.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('the static resolver recognizes the same TypeScript file that app ts-node registration loads', () => {
    expect(
        resolveRuntimeImport(
            root,
            'routes/executors.js',
            '../src/Application/Services/ReversalService',
        ),
    ).toBe(path.join(root, 'src/Application/Services/ReversalService.ts'));
    expect(() =>
        resolveRuntimeImport(root, 'routes/executors.js', '../app.js'),
    ).toThrow('IMPORT_OUTSIDE_RUNTIME_MODULES');
    expect(() =>
        resolveRuntimeImport(
            root,
            'routes/executors.js',
            './missing-runtime-file',
        ),
    ).toThrow();
});

(process.platform === 'win32' ? test : test.skip)(
    'Windows native canvas artifacts can be copied from a loaded matching source without modifying its files',
    () => {
        const temporary = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ahram-canvas-candidate-test-'),
        );
        try {
            const sourceCanvas = path.join(root, 'node_modules/canvas');
            const candidateCanvas = path.join(temporary, 'node_modules/canvas');
            fs.cpSync(sourceCanvas, candidateCanvas, {
                recursive: true,
                filter: (value) =>
                    !value.startsWith(path.join(sourceCanvas, 'build')),
            });
            const sourceBinary = fs.readFileSync(
                path.join(sourceCanvas, 'build/Release/canvas.node'),
            );
            const report = repairCanvasArtifacts(temporary, root);
            expect(report).toMatchObject({
                status: 'COPIED_VERIFIED_NATIVE_ARTIFACTS',
                sourceUnchanged: true,
            });
            expect(
                fs.readFileSync(
                    path.join(sourceCanvas, 'build/Release/canvas.node'),
                ),
            ).toEqual(sourceBinary);
            const child = cp.spawnSync(
                process.execPath,
                [
                    '-e',
                    'const c=require(process.argv[1]);if(!c.createCanvas(1,1).toBuffer("image/png").length)process.exit(1);',
                    candidateCanvas,
                ],
                { encoding: 'utf8', windowsHide: true },
            );
            expect({ status: child.status, error: child.stderr }).toEqual({
                status: 0,
                error: '',
            });
            fs.writeFileSync(
                path.join(candidateCanvas, 'build/Release/canvas.node'),
                'conflicting-candidate-artifact',
            );
            expect(() => repairCanvasArtifacts(temporary, root)).toThrow(
                'CANVAS_TARGET_ARTIFACT_CONFLICT',
            );
            expect(
                fs.readFileSync(
                    path.join(candidateCanvas, 'build/Release/canvas.node'),
                    'utf8',
                ),
            ).toBe('conflicting-candidate-artifact');
            const pkg = JSON.parse(
                fs.readFileSync(
                    path.join(candidateCanvas, 'package.json'),
                    'utf8',
                ),
            );
            fs.writeFileSync(
                path.join(candidateCanvas, 'package.json'),
                JSON.stringify({ ...pkg, version: '0.0.0' }),
            );
            expect(() => repairCanvasArtifacts(temporary, root)).toThrow(
                'CANVAS_VERSION_OR_SOURCE_MISMATCH',
            );
        } finally {
            const real = fs.realpathSync(temporary);
            if (
                path.dirname(real).toLowerCase() !==
                    fs.realpathSync(os.tmpdir()).toLowerCase() ||
                !path.basename(real).startsWith('ahram-canvas-candidate-test-')
            )
                throw new Error('Unsafe fixture cleanup');
            fs.rmSync(real, { recursive: true, force: true });
        }
    },
    30000,
);

test('module scan never executes source and permits ordinary route/schema declarations', () => {
    const source =
        "const express=require('express'); const router=express.Router(); router.post('/send',async()=>{ await Model.create({}); }); const schema=new mongoose.Schema({}); schema.index({id:1}); module.exports={run:()=>setInterval(()=>{},100)};";
    expect(inspectModuleLoad(source, ts)).toEqual([]);
});

test.each([
    ['Model.create({})', 'UNREVIEWED_TOP_LEVEL_CALL'],
    ['setInterval(()=>{},1000)', 'UNREVIEWED_TOP_LEVEL_CALL'],
    [
        '(()=>require("fs").writeFileSync("should-not-exist","bad"))()',
        'UNREVIEWED_TOP_LEVEL_CALL',
    ],
    ['new Worker("queue",()=>{})', 'UNREVIEWED_TOP_LEVEL_CONSTRUCTOR'],
    ['require(process.env.MODULE)', 'DYNAMIC_REQUIRE'],
    [
        'class Boot { static { Model.deleteMany({}) } }',
        'UNREVIEWED_TOP_LEVEL_CALL',
    ],
])(
    'module scan flags executable bootstrap code without invoking it: %s',
    (source, code) => {
        expect(inspectModuleLoad(source, ts)).toEqual(
            expect.arrayContaining([expect.objectContaining({ code })]),
        );
    },
);

test('dependency diagnostics test native functions but redact thrown messages', () => {
    const load = jest.fn((name) => {
        if (name === 'bcrypt')
            return {
                hashSync: () => 'synthetic-hash',
                compareSync: () => true,
            };
        if (name === 'canvas')
            throw Object.assign(new Error('SECRET_MUST_NOT_PRINT'), {
                code: 'MODULE_NOT_FOUND',
            });
        return {};
    });
    const report = inspectPackages(load);
    expect(report.bcrypt).toEqual({ ok: true });
    expect(report.canvas).toEqual({ ok: false, code: 'MODULE_NOT_FOUND' });
    expect(JSON.stringify(report)).not.toContain('SECRET_MUST_NOT_PRINT');
});

test('module import resolution checks paths without loading application code', () => {
    const resolve = jest.fn(() => {
        throw new Error('private-path-must-not-print');
    });
    const result = inspectModuleLoad(
        "const service=require('./missing-service');",
        ts,
        resolve,
    );
    expect(result).toEqual([
        expect.objectContaining({
            code: 'UNRESOLVED_REQUIRE',
            call: 'require',
        }),
    ]);
    expect(JSON.stringify(result)).not.toContain('private-path-must-not-print');
});

test('session index fix changes only the verified candidate file, and is idempotent', () => {
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ahram-session-probe-test-'),
    );
    try {
        fs.mkdirSync(path.join(temporary, 'config'));
        const original = cp.execFileSync('git', [
            '-C',
            root,
            'show',
            'ede6b471bcfe94d7bc47a6d0702eb972b58a4bb2',
        ]);
        const target = path.join(temporary, 'config/sessionStore.js');
        fs.writeFileSync(target, original);
        expect(applyProbeSessionFix(temporary, root)).toBe(
            'APPLIED_TO_CANDIDATE',
        );
        expect(fs.readFileSync(target, 'utf8')).toContain(
            "readRuntimeRole(env) === 'probe' ? 'disabled' : 'native'",
        );
        expect(applyProbeSessionFix(temporary, root)).toBe('ALREADY_APPLIED');
        fs.writeFileSync(target, '/* unexpected edit */');
        expect(() => applyProbeSessionFix(temporary, root)).toThrow(
            'UNEXPECTED_SESSION_STORE_CONTENT',
        );
        expect(fs.readFileSync(target, 'utf8')).toBe('/* unexpected edit */');
        expect(() => applyProbeSessionFix(root, root)).toThrow(
            'CANDIDATE_MUST_BE_SEPARATE',
        );
    } finally {
        if (
            path.dirname(fs.realpathSync(temporary)).toLowerCase() !==
            fs.realpathSync(os.tmpdir()).toLowerCase()
        )
            throw new Error('Unsafe fixture cleanup');
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});
