'use strict';

const assertDevTarget = (env) => {
    if (env.CLOUD_AGENT_DEV_SETUP_ENABLED !== 'true' || env.NODE_ENV !== 'development') {
        throw new Error('Cloud development setup requires explicit opt-in and NODE_ENV=development.');
    }
    let uri;
    try { uri = new URL(env.MONGO_URI); } catch (_) {
        throw new Error('Cloud development database target is invalid.');
    }
    if (uri.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(uri.hostname)
        || uri.port !== '27019' || uri.pathname !== '/ahram_cloud_agent_dev'
        || uri.username || uri.password || uri.searchParams.get('replicaSet') !== 'clouddev') {
        throw new Error('Refusing a database outside the isolated cloud development target.');
    }
};

if (require.main === module) {
    require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });
    try { assertDevTarget(process.env); } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = { assertDevTarget };
