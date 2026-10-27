'use strict';
const ts = require('typescript');
const {
    inspectModuleLoad,
    inspectPackages,
    applyProbeSessionFix,
} = require('../scripts/checkRuntimeCandidate.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');

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
