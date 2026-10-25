'use strict';
// Compatibility facade: shared workspace commands have dedicated modules.
const { normalizeUsername, cleanText, checked } = require('./portalWorkspace/common');
module.exports = {
    ...require('./portalWorkspace/queriesController'),
    ...require('./portalWorkspace/customersController'),
    ...require('./portalWorkspace/customerBalancesController'),
    ...require('./portalWorkspace/settingsController'),
    ...require('./portalWorkspace/companyThemeController'),
    ...require('./portalWorkspace/reportsController'),
    ...require('./portalWorkspace/companyReportsController'),
    helpers: { normalizeUsername, cleanText, checked }
};
