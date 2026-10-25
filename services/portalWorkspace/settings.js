'use strict';

const Settings = require('../../models/Settings');
const { getServiceRatesForTier, getCompanyServiceRates } = require('../../utils/rateHelper');
const { activatePendingRateUpdate } = require('../rateChangeService');
const { pharaonicIconForService } = require('../../utils/companyPortalTheme');
const { SERVICE_CATALOG } = require('./catalog');

const getSettingsAndRates = async (workspace, app) => {
    await activatePendingRateUpdate({ app });
    const settings = (await Settings.findOne({}).lean()) || {};
    const serviceRates = workspace.isCompany
        ? getCompanyServiceRates(workspace.entity, settings)
        : getServiceRatesForTier(workspace.entity.tier || 1, settings);
    return {
        settings,
        ratesUpdatedAt: workspace.entity.rateUpdatedAt || settings.ratesUpdatedAt || null,
        serviceRates,
        services: SERVICE_CATALOG.map((service) => ({
            ...service,
            rate: serviceRates[service.key] || 0,
            pharaonicIcon: pharaonicIconForService(service.key),
        })),
    };
};

module.exports = { getSettingsAndRates };
