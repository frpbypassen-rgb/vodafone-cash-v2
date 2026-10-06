// Compatibility facade: routes keep their existing imports.
module.exports = {
    ...require('./executor/dashboard/pagesController'),
    ...require('./executor/dashboard/proofImagesController'),
    ...require('./executor/dashboard/settingsController'),
    ...require('./executor/dashboard/employeesController'),
    ...require('./executor/dashboard/balancePoolsController'),
    ...require('./executor/dashboard/routingController'),
    ...require('./executor/dashboard/depositsController'),
    ...require('./executor/dashboard/quickExecuteController'),
};
