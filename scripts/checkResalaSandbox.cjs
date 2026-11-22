'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
require('ts-node/register/transpile-only');
const {
    listResalaSent, sendResalaPin, sendResalaTemplate, ResalaError,
} = require('../src/Infrastructure/ResalaClient.ts');

const configFile = path.resolve(__dirname, '../.env.local');
const configured = (env, key) => process.env[key]?.trim() || env[key]?.trim();

async function check(name, run) {
    try {
        return { name, ok: true, ...await run() };
    } catch (error) {
        if (!(error instanceof ResalaError)) return { name, ok: false, type: 'CheckError' };
        return {
            name, ok: false, type: error.type, status: error.status,
            requestId: error.requestId, fields: error.errors && Object.keys(error.errors),
        };
    }
}

async function main() {
    const config = fs.existsSync(configFile) ? dotenv.parse(fs.readFileSync(configFile)) : {};
    const key = configured(config, 'RESALA_API_KEY');
    if (!key) {
        console.log(JSON.stringify({ ok: false, type: 'ConfigurationError', missing: 'RESALA_API_KEY' }, null, 2));
        process.exitCode = 2;
        return;
    }
    process.env.RESALA_API_KEY = key;
    const phone = configured(config, 'RESALA_TEST_PHONE') || '218910001234';
    const templateId = configured(config, 'RESALA_SMS_TEMPLATE_ID');
    const results = [];
    const history = await check('sent-view', async () => {
        const page = await listResalaSent({ q: phone, page: 1, paginate: 1 });
        return { page: page.meta.current_page };
    });
    results.push(history);
    if (!['ConfigurationError', 'Unauthorized', 'TokenExpired'].includes(history.type)) {
        results.push(await check('sandbox-pin', async () => {
            const result = await sendResalaPin(phone, { test: true, service_name: 'Ahram Pay' });
            return { pinLength: result.pin.length, sender: result.sender_name };
        }));
        if (templateId) {
            results.push(await check('sandbox-template', async () => {
                const result = await sendResalaTemplate(templateId, [{ phone, $1: 'اختبار', $2: 'أهرام باي' }], { test: true });
                if (result.queued || result.is_prod) throw new Error('Unconfirmed sandbox response');
                return { valid: result.total_messages, invalid: result.invalid_numbers.length, senders: result.sender_names };
            }));
        }
    }
    const ok = results.every(result => result.ok);
    console.log(JSON.stringify({ ok, results, templateConfigured: Boolean(templateId) }, null, 2));
    if (!ok) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(() => {
        console.error(JSON.stringify({ ok: false, type: 'CheckError' }));
        process.exitCode = 1;
    });
}
module.exports = { main };
