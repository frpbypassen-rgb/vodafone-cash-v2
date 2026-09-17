'use strict';

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const configuredInstanceCount = (env = process.env) => {
    const values = [env.APP_INSTANCE_COUNT, env.WEB_CONCURRENCY, env.PM2_INSTANCES]
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0);
    return values.length ? Math.max(...values) : 1;
};

const distributedStateRequired = (env = process.env) => (
    String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
    || truthy(env.REDIS_REQUIRED)
    || truthy(env.CLUSTER_MODE)
    || configuredInstanceCount(env) > 1
);

module.exports = { configuredInstanceCount, distributedStateRequired };
