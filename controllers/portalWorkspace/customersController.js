const {
    cleanText,
    normalizeUsername,
    assertIdentityAvailable,
    redirectWithMessage,
    requireCustomerManager,
    customerOwnerFilter,
} = require('./common');
('use strict');
const businessPortalService = require('../../services/businessPortalService');
const SubAccount = require('../../models/SubAccount');
const { assignGeneratedAccountCode, CODE_LENGTHS } = require('../../services/accountCodeService');
const { logAction } = require('../../services/auditService');
const { buildMarginStorage } = require('../../utils/agencyPricing');
const { normalizeCreditLimit } = require('../../services/agencyCreditLimitService');
const { SERVICE_RATE_KEYS } = require('../../utils/rateHelper');

exports.postCreateCustomer = async (req, res) => {
    const jsonRequest = req.baseUrl === '/agent-portal' && String(req.headers?.accept || '').includes('application/json');
    const respond = (type, code, status = 400) => jsonRequest
        ? res.status(type === 'customerSuccess' ? 201 : status).json({ success: type === 'customerSuccess', code })
        : redirectWithMessage(res, '/client/customers', type, code);
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);

        const name = cleanText(req.body.name, 120);
        const phone = cleanText(req.body.phone, 32);
        const webPassword = String(req.body.webPassword || '');
        const webUsername = normalizeUsername(req.body.webUsername);
        const pricing = buildMarginStorage({
            marginPiasters: req.body.marginPiasters,
            customMargin: req.body.customMargin,
        });
        const creditLimit = normalizeCreditLimit(req.body.creditLimit);

        if (name.length < 3 || !/^\+?[0-9]{8,15}$/.test(phone) || webPassword.length < 8) {
            return respond('customerError', 'invalid');
        }
        await assertIdentityAvailable({ webUsername, phone });

        const customer = await SubAccount.create({
            masterType: workspace.masterType,
            masterId: workspace.masterId,
            tenantId: (req.tenant && req.tenant._id) || workspace.actor.tenantId || undefined,
            name,
            phone,
            webUsername,
            webPassword,
            ...pricing,
            creditLimit,
            creditLimitUpdatedAt: creditLimit > 0 ? new Date() : undefined,
            creditLimitUpdatedBy: creditLimit > 0 ? workspace.actor.name : undefined,
            creditLimitUpdatedByModel: creditLimit > 0 ? workspace.actorModel : undefined,
            creditLimitUpdatedById: creditLimit > 0 ? workspace.actor._id : undefined,
            status: 'active',
        });

        await assignGeneratedAccountCode({
            Model: SubAccount,
            modelName: 'SubAccount',
            id: customer._id,
            length: CODE_LENGTHS.subAccount,
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            result: 'ناجح',
            metadata: { portal: workspace.type, webUsername, phone },
        });

        return respond('customerSuccess', 'created');
    } catch (error) {
        const code =
            error.message === 'IDENTITY_TAKEN'
                ? 'duplicate'
                : error.message === 'INVALID_USERNAME'
                  ? 'username'
                  : error.code === 'INVALID_CREDIT_LIMIT'
                    ? 'credit_limit'
                    : error.message === 'FORBIDDEN'
                      ? 'forbidden'
                      : 'server';
        console.error('[Business Portal] create customer failed:', error.message);
        return respond('customerError', code, code === 'forbidden' ? 403 : code === 'server' ? 500 : 400);
    }
};

exports.postToggleCustomer = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, '/client/customers', 'customerError', 'notfound');

        customer.status = customer.status === 'active' ? 'banned' : 'active';
        await customer.save();
        await logAction({
            action: 'USER_STATUS_CHANGED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            result: customer.status,
            metadata: { portal: workspace.type },
        });
        return redirectWithMessage(res, '/client/customers', 'customerSuccess', 'status');
    } catch (error) {
        console.error('[Business Portal] toggle customer failed:', error.message);
        return redirectWithMessage(
            res,
            '/client/customers',
            'customerError',
            error.message === 'FORBIDDEN' ? 'forbidden' : 'server'
        );
    }
};

exports.postUpdateCustomerPricing = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        requireCustomerManager(workspace);
        const customer = await SubAccount.findOne(customerOwnerFilter(workspace, req.params.id));
        if (!customer) return redirectWithMessage(res, '/client/customers', 'customerError', 'notfound');

        const serviceMarginPiasters = SERVICE_RATE_KEYS.reduce((result, serviceKey) => {
            result[serviceKey] = req.body[`margin_${serviceKey}`];
            return result;
        }, {});
        const pricing = buildMarginStorage({
            marginPiasters: req.body.marginPiasters,
            customMargin: req.body.customMargin,
            serviceMarginPiasters,
        });
        const oldPricing = {
            marginPiasters: customer.marginPiasters,
            customMargin: customer.customMargin,
            serviceMarginPiasters: customer.serviceMarginPiasters,
        };
        customer.marginPiasters = pricing.marginPiasters;
        customer.customMargin = pricing.customMargin;
        customer.serviceMarginPiasters = pricing.serviceMarginPiasters;
        customer.pricingVersion = pricing.pricingVersion;
        customer.marginUpdatedAt = new Date();
        customer.marginUpdatedBy = workspace.actor.name;
        await customer.save();

        await logAction({
            action: 'SETTINGS_UPDATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: customer._id,
            targetModel: 'SubAccount',
            oldData: oldPricing,
            newData: pricing,
            result: 'ناجح',
            metadata: { portal: workspace.type, section: 'customer_pricing' },
        });

        return redirectWithMessage(res, `/client/customers/${customer._id}`, 'customerSuccess', 'pricing');
    } catch (error) {
        console.error('[Business Portal] customer pricing failed:', error.message);
        return redirectWithMessage(
            res,
            '/client/customers',
            'customerError',
            error.message === 'FORBIDDEN' ? 'forbidden' : 'server'
        );
    }
};
