'use strict';

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const { setWebhook } = require('../services/telegramService');

setWebhook()
    .then((result) => {
        console.log(JSON.stringify({ success: Boolean(result?.ok), webhook: process.env.TELEGRAM_WEBHOOK_URL || `${process.env.PUBLIC_APP_URL}/webhooks/telegram` }));
        process.exit(result?.ok ? 0 : 1);
    })
    .catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
