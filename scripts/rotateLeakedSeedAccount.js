'use strict';

const readline = require('readline');

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const MobileDeviceSession = require('../models/MobileDeviceSession');
const { hashPassword } = require('../services/passwordService');
const { logAction } = require('../services/auditService');
const { initRedis } = require('../config/redis');
const {
    applyCredentialRotation,
    generatePassword,
    runRotation
} = require('./lib/rotateLeakedSeedAccount');

const promptHidden = (question) => new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
        reject(new Error('A hidden prompt requires an interactive terminal. Omit --prompt to generate a password file, or set ROTATION_PASSWORD.'));
        return;
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });
    const mask = (chunk) => {
        const text = String(chunk);
        if (text.includes('\n') || text.includes('\r')) return;
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', mask);
    rl.question(question, (answer) => {
        process.stdin.removeListener('data', mask);
        rl.close();
        process.stdout.write('\n');
        resolve(String(answer || ''));
    });
});

const findEmployee = (username) => Employee.findOne({ webUsername: username })
    .select('_id webUsername role status sessionVersion')
    .lean();

const resolvePassword = async (argv, env) => {
    if (argv.includes('--prompt')) return promptHidden('New password (hidden): ');
    const fromEnv = String(env.ROTATION_PASSWORD || '');
    if (fromEnv) return fromEnv;
    return generatePassword();
};

const applyChanges = async ({ employee, passwordHash }) => {
    await initRedis();
    const listed = await mongoose.connection.db.listCollections({ name: 'sessions' }).toArray();
    const sessions = listed.length ? mongoose.connection.db.collection('sessions') : null;
    const dbSession = await mongoose.startSession();
    try {
        let result = null;
        await dbSession.withTransaction(async () => {
            result = await applyCredentialRotation({
                employee,
                passwordHash,
                models: { Employee, MobileDeviceSession, sessions },
                logAction,
                session: dbSession
            });
        });
        return result || { mobileSessionsRevoked: 0, webSessionsDeleted: 0 };
    } finally {
        await dbSession.endSession();
    }
};

const safeFailure = (error, env) => {
    const message = String(error && error.message ? error.message : '');
    const secret = String(env.ROTATION_PASSWORD || '');
    if (/mongodb(?:\+srv)?:\/\//i.test(message) || (secret && message.includes(secret))) {
        return 'Rotation failed. Details were omitted.\n';
    }
    return '';
};

const main = async (argv = process.argv, env = process.env, io = {}) => {
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    const apply = argv.includes('--apply');
    if (!String(env.MONGO_URI || '').trim()) {
        stderr.write('MONGO_URI is required. The connection string is not printed.\n');
        return 1;
    }

    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);

    try {
        await mongoose.connect(env.MONGO_URI, {
            serverSelectionTimeoutMS: Number(env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15000,
            autoIndex: false,
            autoCreate: false
        });
        try {
            await runRotation({
                apply,
                findEmployee,
                hashPassword,
                applyChanges,
                resolvePassword: () => resolvePassword(argv, env),
                persistPasswordFile: apply && !argv.includes('--prompt') && !String(env.ROTATION_PASSWORD || ''),
                stdout,
                stderr
            });
            return 0;
        } catch (error) {
            const hidden = safeFailure(error, env);
            if (hidden) stderr.write(hidden);
            return 1;
        } finally {
            delete env.ROTATION_PASSWORD;
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        }
    } catch (error) {
        stderr.write(safeFailure(error, env) || 'Rotation failed. The connection string was not printed.\n');
        return 1;
    }
};

if (require.main === module) {
    main().then((code) => {
        process.exitCode = code;
    }).catch(() => {
        console.error('Rotation failed.');
        process.exitCode = 1;
    });
}

module.exports = {
    main,
    resolvePassword
};
