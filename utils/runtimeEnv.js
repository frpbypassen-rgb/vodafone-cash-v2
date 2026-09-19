'use strict';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const clean = (value) => String(value || '').trim();
const nodeEnv = (env = process.env) => clean(env.NODE_ENV).toLowerCase();
const isEnabled = (value) => TRUE_VALUES.has(clean(value).toLowerCase());
const isProduction = (env = process.env) => nodeEnv(env) === 'production';
const isStaging = (env = process.env) => nodeEnv(env) === 'staging';
const isTest = (env = process.env) => nodeEnv(env) === 'test';
const isDevelopment = (env = process.env) => {
    const envName = nodeEnv(env);
    return envName === '' || envName === 'development';
};
const isLocalRuntime = (env = process.env) => isDevelopment(env) || isTest(env);
const isSecureRuntime = (env = process.env) => isProduction(env) || isStaging(env);

module.exports = {
    clean,
    isDevelopment,
    isEnabled,
    isLocalRuntime,
    isProduction,
    isSecureRuntime,
    isStaging,
    isTest,
    nodeEnv
};
