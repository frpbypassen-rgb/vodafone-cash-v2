'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const targetPath = path.resolve(process.argv[2] || process.env.ENV_FILE_PATH || '.env');
const source = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';

const readValue = (key) => {
    const match = source.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return String(match?.[1] || '').trim();
};

if (readValue('WEB_PUSH_PUBLIC_KEY') && readValue('WEB_PUSH_PRIVATE_KEY')) {
    console.log('Web Push VAPID credentials are already configured.');
    process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const updates = new Map([
    ['WEB_PUSH_PUBLIC_KEY', keys.publicKey],
    ['WEB_PUSH_PRIVATE_KEY', keys.privateKey]
]);
const written = new Set();
const lines = source ? source.split(/\r?\n/) : [];
const nextLines = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !updates.has(match[1])) return line;
    written.add(match[1]);
    return `${match[1]}=${updates.get(match[1])}`;
});

for (const [key, value] of updates) {
    if (!written.has(key)) nextLines.push(`${key}=${value}`);
}

fs.writeFileSync(targetPath, `${nextLines.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
console.log('Generated persistent Web Push VAPID credentials.');
