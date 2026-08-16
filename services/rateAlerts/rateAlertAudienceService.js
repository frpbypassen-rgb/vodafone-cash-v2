'use strict';

const User = require('../../models/User');
const ClientCompany = require('../../models/ClientCompany');
const ClientEmployee = require('../../models/ClientEmployee');
const AgentEmployee = require('../../models/AgentEmployee');
const SubAccount = require('../../models/SubAccount');
const {
    SERVICE_RATE_CONFIG,
    SERVICE_RATE_KEYS,
    getServiceRatesForTier,
    getCompanyServiceRates
} = require('../../utils/rateHelper');
const { applyCustomerRateMargins } = require('../../utils/agencyPricing');

const DEFAULT_DELAY_SECONDS = 60;

const uniqueStrings = (values = []) => [...new Set(values.filter(Boolean).map(String))];

const plainSettings = (settings) => {
    if (!settings) return {};
    if (typeof settings.toObject === 'function') {
        return settings.toObject({ depopulate: true, getters: false, virtuals: false });
    }
    return { ...settings };
};

const withRateChanges = (settings, changes = {}) => ({
    ...plainSettings(settings),
    ...changes
});

const formatRate = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(numeric)
        : '---';
};

const buildEffectiveRateChanges = (currentRates = {}, nextRates = {}) => (
    SERVICE_RATE_KEYS.reduce((rows, serviceKey) => {
        const oldRate = Number(currentRates[serviceKey]);
        const newRate = Number(nextRates[serviceKey]);
        if (!Number.isFinite(oldRate) || !Number.isFinite(newRate)) return rows;
        if (Math.abs(newRate - oldRate) < 0.005) return rows;
        rows.push({
            serviceKey,
            label: SERVICE_RATE_CONFIG[serviceKey]?.label || serviceKey,
            oldRate: Number(oldRate.toFixed(2)),
            newRate: Number(newRate.toFixed(2)),
            difference: Number((newRate - oldRate).toFixed(2)),
            direction: newRate > oldRate ? 'up' : 'down'
        });
        return rows;
    }, [])
);

const formatEffectiveRateChanges = (rateChanges = []) => rateChanges
    .map((row) => `${row.label}: ${formatRate(row.oldRate)} → ${formatRate(row.newRate)} ${row.direction === 'up' ? '↑' : '↓'}`)
    .join('\n');

const formatCurrentRates = (rateChanges = []) => rateChanges
    .map((row) => `${row.label}: ${formatRate(row.newRate)}`)
    .join('\n');

const normalizeDelaySeconds = (value, fallback = DEFAULT_DELAY_SECONDS) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return normalizeDelaySeconds(fallback, DEFAULT_DELAY_SECONDS);
    return Math.min(3600, Math.max(10, Math.round(parsed)));
};

const formatDelay = (seconds) => {
    const normalized = normalizeDelaySeconds(seconds);
    return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
};

const buildPersonalizedPayload = ({
    currentRates,
    nextRates,
    effectiveAt,
    delaySeconds,
    campaignReference = ''
}) => {
    if (!currentRates || !nextRates) return null;
    const rateChanges = buildEffectiveRateChanges(currentRates, nextRates);
    if (!rateChanges.length) return null;
    const safeDelay = normalizeDelaySeconds(delaySeconds);
    const directions = new Set(rateChanges.map((row) => row.direction));
    return {
        effectiveAt: new Date(effectiveAt).toISOString(),
        delaySeconds: safeDelay,
        countdown: formatDelay(safeDelay),
        campaignReference: String(campaignReference || ''),
        direction: directions.size === 1 ? [...directions][0] : 'mixed',
        rateChanges,
        changes: Object.fromEntries(rateChanges.map((row) => [row.serviceKey, row.newRate])),
        previousRates: Object.fromEntries(rateChanges.map((row) => [row.serviceKey, row.oldRate])),
        rateChangesText: formatEffectiveRateChanges(rateChanges),
        currentRatesText: formatCurrentRates(rateChanges)
    };
};

const accountRates = ({ model, account, master, settings }) => {
    if (model === 'ClientCompany') return getCompanyServiceRates(account, settings);
    if (model === 'SubAccount') {
        if (!master) return null;
        const masterRates = account.masterType === 'company'
            ? getCompanyServiceRates(master, settings)
            : getServiceRatesForTier(master.tier || 1, settings);
        return applyCustomerRateMargins(masterRates, account);
    }
    return getServiceRatesForTier(account?.tier || 1, settings);
};

const buildAudienceEntry = ({
    model,
    account,
    master,
    currentSettings,
    nextSettings,
    effectiveAt,
    delaySeconds,
    campaignReference,
    staff = []
}) => {
    const currentRates = accountRates({ model, account, master, settings: currentSettings });
    const nextRates = accountRates({ model, account, master, settings: nextSettings });
    if (!currentRates || !nextRates) return null;
    const payload = buildPersonalizedPayload({
        currentRates,
        nextRates,
        effectiveAt,
        delaySeconds,
        campaignReference
    });
    if (!payload) return null;

    const phoneRecipients = [account, ...staff]
        .filter((row) => row?.phone)
        .map((row) => ({
            id: row._id,
            name: row.name || row.webUsername || row.phone || 'عميل الأهرام',
            phone: row.phone,
            model: row === account ? model : (model === 'ClientCompany' ? 'ClientEmployee' : 'AgentEmployee'),
            payload
        }));

    return {
        recipientId: String(account._id),
        recipientModel: model,
        recipientName: account.name || account.webUsername || account.phone || 'عميل الأهرام',
        notificationUserId: String(account._id),
        pushUserIds: uniqueStrings([account._id, ...staff.map((row) => row._id)]),
        phoneRecipients,
        payload
    };
};

const buildRateAlertAudience = async ({
    settings,
    changes,
    effectiveAt,
    delaySeconds,
    campaignReference = ''
}) => {
    const [users, companies, subAccounts, clientEmployees, agentEmployees] = await Promise.all([
        User.find({ status: 'active' }).select('_id name phone webUsername role tier').lean(),
        ClientCompany.find({ status: 'active' }).select('_id name phone tier rateMode rateOffsets exchangeRate').lean(),
        SubAccount.find({ status: 'active' }).select('_id name phone webUsername masterType masterId customMargin marginPiasters serviceMarginPiasters pricingVersion').lean(),
        ClientEmployee.find({ status: 'active' }).select('_id name phone webUsername companyId').lean(),
        AgentEmployee.find({ status: 'active' }).select('_id name phone webUsername agentId').lean()
    ]);
    const currentSettings = plainSettings(settings);
    const nextSettings = withRateChanges(settings, changes);
    const usersById = new Map(users.map((row) => [String(row._id), row]));
    const companiesById = new Map(companies.map((row) => [String(row._id), row]));
    const companyStaff = new Map();
    const agentStaff = new Map();
    clientEmployees.forEach((row) => {
        const key = String(row.companyId);
        companyStaff.set(key, [...(companyStaff.get(key) || []), row]);
    });
    agentEmployees.forEach((row) => {
        const key = String(row.agentId);
        agentStaff.set(key, [...(agentStaff.get(key) || []), row]);
    });

    const entries = [];
    users.forEach((account) => {
        entries.push(buildAudienceEntry({
            model: 'User',
            account,
            currentSettings,
            nextSettings,
            effectiveAt,
            delaySeconds,
            campaignReference,
            staff: agentStaff.get(String(account._id)) || []
        }));
    });
    companies.forEach((account) => {
        entries.push(buildAudienceEntry({
            model: 'ClientCompany',
            account,
            currentSettings,
            nextSettings,
            effectiveAt,
            delaySeconds,
            campaignReference,
            staff: companyStaff.get(String(account._id)) || []
        }));
    });
    subAccounts.forEach((account) => {
        const master = account.masterType === 'company'
            ? companiesById.get(String(account.masterId))
            : usersById.get(String(account.masterId));
        entries.push(buildAudienceEntry({
            model: 'SubAccount',
            account,
            master,
            currentSettings,
            nextSettings,
            effectiveAt,
            delaySeconds,
            campaignReference
        }));
    });
    return entries.filter(Boolean);
};

const buildPendingRateAlertForClient = async ({ accountType, clientId, settings }) => {
    const pending = settings?.pendingRateUpdate;
    if (!clientId || !pending?.effectiveAt || !pending?.changes) return null;
    if (new Date(pending.effectiveAt).getTime() <= Date.now()) return null;

    let model = 'User';
    let account = null;
    let master = null;
    const normalizedType = String(accountType || '').toLowerCase();
    if (normalizedType === 'company' || normalizedType === 'client_company') {
        const employee = await ClientEmployee.findById(clientId).select('companyId status').lean();
        if (!employee || employee.status !== 'active') return null;
        model = 'ClientCompany';
        account = await ClientCompany.findById(employee.companyId).lean();
    } else if (normalizedType === 'agent_staff') {
        const employee = await AgentEmployee.findById(clientId).select('agentId status').lean();
        if (!employee || employee.status !== 'active') return null;
        account = await User.findById(employee.agentId).lean();
    } else if (normalizedType === 'sub_client') {
        model = 'SubAccount';
        account = await SubAccount.findById(clientId).lean();
        if (account) {
            master = account.masterType === 'company'
                ? await ClientCompany.findById(account.masterId).lean()
                : await User.findById(account.masterId).lean();
        }
    } else {
        account = await User.findById(clientId).lean();
    }
    if (!account || account.status !== 'active') return null;

    const currentSettings = plainSettings(settings);
    const nextSettings = withRateChanges(settings, pending.changes || {});
    return buildPersonalizedPayload({
        currentRates: accountRates({ model, account, master, settings: currentSettings }),
        nextRates: accountRates({ model, account, master, settings: nextSettings }),
        effectiveAt: pending.effectiveAt,
        delaySeconds: pending.delaySeconds || settings.rateChangeDelaySeconds,
        campaignReference: pending.campaignReference
    });
};

module.exports = {
    DEFAULT_DELAY_SECONDS,
    normalizeDelaySeconds,
    formatDelay,
    buildEffectiveRateChanges,
    formatEffectiveRateChanges,
    formatCurrentRates,
    buildPersonalizedPayload,
    buildRateAlertAudience,
    buildPendingRateAlertForClient,
    withRateChanges
};
