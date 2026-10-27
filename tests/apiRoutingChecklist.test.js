'use strict';
const {
    csvCell,
    buildChecklist,
    loadAccounts,
    scanStaticOrigins,
    createPrivateReviewDirectory,
} = require('../scripts/exportApiRoutingChecklist.cjs');

test('CSV cells preserve Arabic and separators while neutralizing spreadsheet formulas', () => {
    expect(csvCell('شركة "الأهرام", ليبيا')).toBe('"شركة ""الأهرام"", ليبيا"');
    for (const value of [
        '=HYPERLINK("bad")',
        '+1+1',
        '-1+1',
        '@SUM(1)',
        '  =1',
        '\t=1',
    ])
        expect(csvCell(value).startsWith('"\'')).toBe(true);
});

test('checklist contains only account identifiers and intentionally empty verification fields', () => {
    const csv = buildChecklist(
        [
            {
                accountType: 'company',
                accountCode: 'CO001',
                name: 'شركة تجريبية',
                token: 'SECRET_MUST_NOT_APPEAR',
                balance: 9876543,
            },
        ],
        'https://ahrampay.com',
    );
    expect(csv).toContain('شركة تجريبية');
    expect(csv).toContain('https://ahrampay.com/api/v1/merchant');
    expect(csv).not.toContain('SECRET_MUST_NOT_APPEAR');
    expect(csv).not.toContain('9876543');
    expect(csv).toContain('verified_client_base_url');
    expect(csv.split('\r\n')[1]).toMatch(/,"","","",""$/);
});

test('directory queries include current and legacy API account candidates with bounded secret-free projections', async () => {
    const calls = [];
    const db = {
        collection: (name) => ({
            find: (filter, options) => {
                calls.push({ name, filter, options });
                const cursor = {
                    limit: jest.fn().mockReturnThis(),
                    maxTimeMS: jest.fn().mockReturnThis(),
                    toArray: jest
                        .fn()
                        .mockResolvedValue(
                            name === 'clientcompanies'
                                ? [{ accountCode: 'CO001', name: 'Company' }]
                                : [{ agentCode: 'AG001', name: 'Agent' }],
                        ),
                };
                calls[calls.length - 1].cursor = cursor;
                return cursor;
            },
        }),
    };
    const result = await loadAccounts(db, 50);
    expect(result.rows.map((row) => row.accountType)).toEqual([
        'company',
        'agent',
    ]);
    for (const call of calls) {
        expect(call.filter.status).toBe('active');
        expect(call.filter.$or).toContainEqual({
            'integrationAccess.apiEnabled': true,
        });
        expect(call.filter.$or).toContainEqual({
            merchantApiKeyHash: { $type: 'string', $ne: '' },
        });
        expect(call.options.projection).toEqual({
            _id: 1,
            name: 1,
            accountCode: 1,
            agentCode: 1,
        });
        expect(call.cursor.limit).toHaveBeenCalledWith(51);
        expect(call.cursor.maxTimeMS).toHaveBeenCalledWith(1500);
    }
    expect(calls[1].filter.role).toBe('agent');
    expect(calls[0].filter.$or).toContainEqual({
        token: { $type: 'string', $ne: '' },
    });
    expect(calls[1].filter.$or).toContainEqual({
        apiToken: { $type: 'string', $ne: '' },
    });
});

test('static Flutter hints never print URL credentials, paths or queries and do not scan build output', () => {
    const fs = require('node:fs'),
        path = require('node:path'),
        os = require('node:os');
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ahram-routing-hint-test-'),
    );
    try {
        fs.mkdirSync(path.join(root, 'flutter/lib'), { recursive: true });
        fs.mkdirSync(path.join(root, 'flutter/build'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'flutter/lib/config.dart'),
            'const url="http://user:PRIVATE_SECRET@102.213.183.6:3000/api?token=PRIVATE_QUERY";',
        );
        fs.writeFileSync(
            path.join(root, 'flutter/build/ignore.dart'),
            'const url="http://ignored.example:3000";',
        );
        const result = scanStaticOrigins(root);
        expect(result.scannedFiles).toBe(1);
        expect(result.hints).toHaveLength(1);
        expect(result.hints[0]).toMatchObject({
            origin: 'http://102.213.183.6:3000',
            sourceCodeOnly: true,
        });
        expect(JSON.stringify(result)).not.toMatch(
            /PRIVATE_SECRET|PRIVATE_QUERY|ignored\.example/,
        );
    } finally {
        const real = fs.realpathSync(root);
        if (
            path.dirname(real).toLowerCase() !==
                fs.realpathSync(os.tmpdir()).toLowerCase() ||
            !path.basename(real).startsWith('ahram-routing-hint-test-')
        )
            throw new Error('Unsafe fixture cleanup');
        fs.rmSync(real, { recursive: true, force: true });
    }
});

test('review artifacts get a fresh directory protected for the operator before any account data is written', () => {
    const fs = require('node:fs'),
        path = require('node:path'),
        os = require('node:os');
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ahram-routing-acl-test-'),
    );
    try {
        const folder = createPrivateReviewDirectory(root);
        expect(path.dirname(folder)).toBe(
            path.join(fs.realpathSync(root), 'runtime-routing-review'),
        );
        expect(fs.readdirSync(folder)).toEqual([]);
        fs.writeFileSync(path.join(folder, 'check.csv'), 'synthetic metadata', {
            flag: 'wx',
            mode: 0o600,
        });
        expect(fs.readFileSync(path.join(folder, 'check.csv'), 'utf8')).toBe(
            'synthetic metadata',
        );
        expect(createPrivateReviewDirectory(root)).not.toBe(folder);
    } finally {
        const real = fs.realpathSync(root);
        if (
            path.dirname(real).toLowerCase() !==
                fs.realpathSync(os.tmpdir()).toLowerCase() ||
            !path.basename(real).startsWith('ahram-routing-acl-test-')
        )
            throw new Error('Unsafe fixture cleanup');
        fs.rmSync(real, { recursive: true, force: true });
    }
}, 15000);
