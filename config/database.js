// config/database.js
const mongoose = require('mongoose');
const logger = require('../utils/logger');

mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const transactionsRequired = () => (
    String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    || truthy(process.env.MONGO_TRANSACTIONS_REQUIRED)
);

const mongoOptions = () => ({
    retryWrites: false,
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 15000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 120000),
    heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_FREQUENCY_MS || 10000),
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 50),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
    waitQueueTimeoutMS: Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS || 15000)
});

const topologyFromHello = (hello) => {
    if (hello?.msg === 'isdbgrid') return 'sharded-cluster';
    if (hello?.setName) return `replica-set:${hello.setName}`;
    return 'standalone';
};

const assertFinancialTopology = async (connection) => {
    if (!transactionsRequired()) return;
    const hello = await connection.db.admin().command({ hello: 1 });
    const topology = topologyFromHello(hello);
    if (topology === 'standalone') {
        const error = new Error(
            'MongoDB must run as a replica set or sharded cluster while financial transactions are required.'
        );
        error.code = 'MONGO_TRANSACTIONS_UNSUPPORTED';
        throw error;
    }
    logger.info('MongoDB financial topology verified', { topology });
};

let listenersAttached = false;
const attachConnectionMonitoring = () => {
    if (listenersAttached) return;
    listenersAttached = true;
    const connection = mongoose.connection;
    connection.on('connected', () => logger.info('MongoDB connection established'));
    connection.on('reconnected', () => logger.info('MongoDB connection restored'));
    connection.on('disconnected', () => logger.error('MongoDB connection lost; waiting for automatic recovery'));
    connection.on('error', (error) => logger.error('MongoDB connection error', { error: error.message }));
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const connectDB = async () => {
    // 🧪 وضع تجريبي: إذا كان MONGO_URI فارغاً أو يساوي 'demo'
    const mongoUri = process.env.MONGO_URI;
    
    if (!mongoUri || mongoUri === 'demo' || mongoUri === 'DEMO') {
        console.log('[Database] 🧪 لم يتم تحديد MONGO_URI — تشغيل الوضع التجريبي...');
        const { connectMockDB } = require('./mockDatabase');
        return await connectMockDB();
    }

    attachConnectionMonitoring();
    const maxAttempts = Math.max(1, Number(process.env.MONGO_CONNECT_MAX_ATTEMPTS || 12));
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const conn = await mongoose.connect(mongoUri, mongoOptions());
            await assertFinancialTopology(conn.connection);
            console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);
            return conn;
        } catch (error) {
            lastError = error;
            if (error.code === 'MONGO_TRANSACTIONS_UNSUPPORTED') {
                console.error(`[Database Error] ${error.message}`);
                throw error;
            }
            await mongoose.disconnect().catch(() => {});
            if (attempt === maxAttempts) break;
            const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt - 1, 5)));
            logger.warn('MongoDB connection attempt failed; retrying', {
                attempt,
                maxAttempts,
                retryInMs: delay,
                error: error.message
            });
            await sleep(delay);
        }
    }

    console.error(`[Database Error] Connection failed after ${maxAttempts} attempts: ${lastError?.message || 'unknown error'}`);
    throw lastError || new Error('MongoDB connection failed');
};

module.exports = connectDB;
module.exports.mongoOptions = mongoOptions;
module.exports.topologyFromHello = topologyFromHello;
module.exports.transactionsRequired = transactionsRequired;
