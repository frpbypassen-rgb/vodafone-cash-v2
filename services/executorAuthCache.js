'use strict';

const Employee = require('../models/Employee');

const DEFAULT_TTL_MS = 15 * 1000;
const MAX_TTL_MS = 60 * 1000;
const EMPLOYEE_FIELDS = 'name phone role status groupId webUsername telegramId canViewAllReports balance';
const GROUP_FIELDS = [
    'name',
    'status',
    'balance',
    'manualTaskRoutingEnabled',
    'manualProofRequired',
    'manualAllowedPhoneLengths',
    'manualSplitRequiresFullPhone',
    'manualReceiptPrefix',
    'parentGroupId'
].join(' ');

const cache = new Map();

const cacheTtlMs = (env = process.env) => {
    const configured = Number(env.EXECUTOR_AUTH_CACHE_MS);
    if (Number.isFinite(configured) && configured >= 1000 && configured <= MAX_TTL_MS) {
        return Math.floor(configured);
    }
    return DEFAULT_TTL_MS;
};

const cacheKey = (executorId) => String(executorId || '');

const getCachedExecutor = (executorId, now = Date.now()) => {
    const key = cacheKey(executorId);
    if (!key) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.value;
};

const setCachedExecutor = (executorId, value, { now = Date.now(), ttlMs = cacheTtlMs() } = {}) => {
    const key = cacheKey(executorId);
    if (!key || !value) return;
    cache.set(key, { value, expiresAt: now + ttlMs });
};

const invalidateExecutorAuth = (executorId) => {
    const key = cacheKey(executorId);
    if (key) cache.delete(key);
};

const clearExecutorAuthCache = () => {
    cache.clear();
};

const queryActiveExecutor = (executorId) => (
    Employee.findById(executorId)
        .select(EMPLOYEE_FIELDS)
        .populate({ path: 'groupId', select: GROUP_FIELDS })
);

const loadExecutorEmployee = async (executorId, { fresh = false, lean = true } = {}) => {
    const id = cacheKey(executorId);
    if (!id) return null;
    if (!fresh && lean) {
        const cached = getCachedExecutor(id);
        if (cached) return cached;
    }

    if (!lean) {
        return Employee.findById(id).populate('groupId');
    }

    let query = queryActiveExecutor(id);
    if (typeof query.lean === 'function') query = query.lean();
    const employee = await query;
    if (employee) setCachedExecutor(id, employee);
    return employee;
};

module.exports = {
    DEFAULT_TTL_MS,
    EMPLOYEE_FIELDS,
    GROUP_FIELDS,
    cacheTtlMs,
    clearExecutorAuthCache,
    getCachedExecutor,
    invalidateExecutorAuth,
    loadExecutorEmployee,
    setCachedExecutor
};
