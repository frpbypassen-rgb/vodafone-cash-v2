'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('ignores environment overrides and private certificate keys while keeping templates', () => {
    const files = [
        '.env',
        '.env.test',
        '.env.production.local',
        'nested/.env.backup',
        'server.key',
        'server.pem',
        'server.pfx',
        '.env.example',
        '.env.staging.example',
    ];
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: root,
        input: files.join('\n') + '\n',
        encoding: 'utf8',
        windowsHide: true,
    });
    expect(result.status).toBe(0);
    const ignored = result.stdout.trim().split(/\r?\n/);
    for (const file of files.slice(0, 7)) expect(ignored).toContain(file);
    expect(ignored).not.toContain('.env.example');
    expect(ignored).not.toContain('.env.staging.example');
});
