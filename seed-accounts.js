'use strict';

const { assertExplicitNonProductionMongoUri } = require('./scripts/lib/productionDatabaseGuard');

const DISABLED_MESSAGE = [
    'seed-accounts.js is disabled.',
    'It previously contained hard-coded credentials and a production database name.',
    'This command does not connect and does not write.',
    'For local demo data, use scripts/seedLocalMobileDemo.js or scripts/seedLocalExecutorAccounts.js with passwords supplied from the environment.',
    'If the leaked operator account exists in production, rotate it with scripts/rotateLeakedSeedAccount.js.'
].join(' ');

const evaluateSeedAccounts = (env = process.env) => {
    assertExplicitNonProductionMongoUri(env);
    const error = new Error(DISABLED_MESSAGE);
    error.code = 'SCRIPT_DISABLED';
    throw error;
};

const main = (env = process.env) => {
    try {
        evaluateSeedAccounts(env);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
};

if (require.main === module) {
    main(process.env);
}

module.exports = {
    DISABLED_MESSAGE,
    evaluateSeedAccounts,
    main
};
