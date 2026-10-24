'use strict';
// Idempotent setup: existing VAPID keys are preserved. Never print private keys.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { generateVAPIDKeys } = require('web-push');
const file = path.resolve(process.argv[2] || '.env');
if (!fs.existsSync(file)) throw new Error('Environment file not found; pass the intended environment file explicitly.');
const source = fs.readFileSync(file, 'utf8');
const values = dotenv.parse(source);
if (values.WEB_PUSH_PUBLIC_KEY && values.WEB_PUSH_PRIVATE_KEY) {
    console.log('Web Push keys are already configured. Existing subscriptions are preserved.');
} else {
    if (values.WEB_PUSH_PUBLIC_KEY || values.WEB_PUSH_PRIVATE_KEY) throw new Error('Incomplete VAPID pair: restore the matching key before continuing. No keys changed.');
    const keys = generateVAPIDKeys();
    const additions = { WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey,
        WEB_PUSH_SUBJECT: values.WEB_PUSH_SUBJECT || 'mailto:support@ahrampay.com' };
    let updated = source;
    for (const [key, value] of Object.entries(additions)) {
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        updated = pattern.test(updated) ? updated.replace(pattern, `${key}=${value}`) : `${updated.trimEnd()}\n${key}=${value}\n`;
    }
    fs.writeFileSync(file, updated, { mode: 0o600 });
    console.log('Web Push keys saved to the selected environment file. Restart the application to load them.');
}
