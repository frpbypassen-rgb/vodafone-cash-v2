'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assertDevTarget } = require('../.cursor/validate-dev-target');
const safe = {
    NODE_ENV: 'development', CLOUD_AGENT_DEV_SETUP_ENABLED: 'true',
    MONGO_URI: 'mongodb://127.0.0.1:27019/ahram_cloud_agent_dev?replicaSet=clouddev'
};

test('permits only the explicitly opted-in dedicated local development database', () => {
    expect(() => assertDevTarget(safe)).not.toThrow();
});
test.each([
    { NODE_ENV: 'production' }, { NODE_ENV: 'staging' }, { CLOUD_AGENT_DEV_SETUP_ENABLED: '' },
    { MONGO_URI: 'mongodb://127.0.0.1:27019/vodafone_cash_system?replicaSet=clouddev' },
    { MONGO_URI: 'mongodb://127.0.0.1:27017/ahram_cloud_agent_dev?replicaSet=clouddev' },
    { MONGO_URI: 'mongodb://remote.example:27019/ahram_cloud_agent_dev?replicaSet=clouddev' },
    { MONGO_URI: 'mongodb://127.0.0.1:27019/?replicaSet=clouddev' },
    { MONGO_URI: 'mongodb://127.0.0.1:27019/ahram_cloud_agent_dev?replicaSet=rs0' }
])('seed refuses unsafe target before connecting: %j', async (change) => {
    const env = { ...safe, ...change };
    const connect = jest.fn();
    const errors = [];
    const source = fs.readFileSync(path.join(__dirname, '../.cursor/seed-dev.js'), 'utf8');
    const load = (name) => {
        if (name === 'dotenv') return { config: jest.fn() };
        if (name === 'mongoose') return { connect, connection: { readyState: 0 }, disconnect: jest.fn().mockResolvedValue() };
        if (name === 'bcryptjs') return { hash: jest.fn() };
        if (name === './validate-dev-target') return { assertDevTarget };
        throw new Error('Unexpected dependency');
    };
    vm.runInNewContext(source, {
        require: load, process: { env, exit: jest.fn(), exitCode: 0 },
        console: { log: jest.fn(), error: (...args) => errors.push(args) }
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(connect).not.toHaveBeenCalled();
    expect(errors.length).toBeGreaterThan(0);
});

test('start validates its target before creating or starting anything', () => {
    const source = fs.readFileSync(path.join(__dirname, '../.cursor/start.sh'), 'utf8');
    expect(source.indexOf('node .cursor/validate-dev-target.js')).toBeLessThan(source.indexOf('mkdir -p'));
    expect(source).not.toMatch(/sudo chown|DBPATH="\/data\/db"|PORT=27017|continuing/);
});
