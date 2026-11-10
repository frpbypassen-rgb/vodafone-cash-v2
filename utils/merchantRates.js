'use strict';

const { getCompanyServiceRates } = require('./rateHelper');

const MERCHANT_RATES_UPDATED = 'rates.updated';

const buildMerchantRates = (merchant, settings) => {
    const serviceRates = getCompanyServiceRates(merchant, settings);
    return { exchange_rate: serviceRates.vodafone, service_rates: serviceRates };
};

module.exports = { MERCHANT_RATES_UPDATED, buildMerchantRates };
