'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('../utils/requestRateLimit');
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { resolveWorkspace } = require('../services/businessPortalService');
const service = require('../services/merchantIntegrationService');
const { logAction } = require('../services/auditService');
const Company = require('../models/ClientCompany');
const User = require('../models/User');
const Employee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const { adminAccountFindQuery } = require('../services/adminAccountVisibilityService');
const { tenantMode } = require('../middlewares/tenantResolver');
const paths = (suffix) => ['/client/api/integrations' + suffix, '/agent-portal/api/integrations' + suffix];
const limited = rateLimit({
    windowMs: 900000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.session.accountType}:${req.session.clientId}`,
    message: { success: false, error: 'طلبات كثيرة. حاول لاحقاً.' },
});
const authorizedWorkspace = async (req) => {
    const workspace = await resolveWorkspace(req);
    service.assertOwner(workspace);
    if (tenantMode() === 'multi' && (!req.tenant?._id ||
        String(workspace.entity.tenantId || '') !== String(req.tenant._id) ||
        String(workspace.actor.tenantId || '') !== String(req.tenant._id)))
        throw service.fail('INTEGRATION_ACCESS_DENIED', 'الحساب غير متاح في هذه المنشأة.');
    return workspace;
};
const handle = (action) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        const workspace = await authorizedWorkspace(req);
        if (req.method !== 'GET') {
            const password = req.body?.currentPassword;
            if (typeof password !== 'string' || password.length > 128)
                throw service.fail('PASSWORD_REQUIRED', 'أدخل كلمة المرور الحالية.', 400);
            const Model = { ClientEmployee: Employee, AgentEmployee, User }[workspace.actorModel];
            const actor = Model && (await Model.findById(workspace.actor._id).select('webPassword').lean());
            if (!actor || !(await bcrypt.compare(password, actor.webPassword || '')))
                throw service.fail('PASSWORD_INVALID', 'كلمة المرور الحالية غير صحيحة.', 400);
        }
        if(req.path.endsWith('/ip-policy') && req.body?.ipAllowlistEnabled === true && !require('../utils/merchantIpPolicy').sourceIp(req))
            throw service.fail('PROXY_CONFIGURATION_REQUIRED','تعذر تحديد IP بأمان. يلزم ضبط عناوين البروكسي الموثوقة صراحةً على الخادم قبل التفعيل.',503);
        const data = await action(workspace, req.body || {});
        if (req.method !== 'GET')
            await logAction({
                action: req.path.endsWith('/ip-policy') ? 'MERCHANT_API_IP_POLICY_UPDATED' : req.path.endsWith('/rotate')
                    ? 'MERCHANT_API_KEY_ROTATED'
                    : 'MERCHANT_API_KEY_REVOKED',
                req,
                performedById: workspace.actor._id,
                performedByModel: workspace.actorModel,
                performedByName: workspace.actor.name,
                targetId: workspace.entity._id,
                targetModel: workspace.entityModel,
                result: 'ناجح',
                metadata: req.path.endsWith('/ip-policy') ? { ipAllowlistEnabled: data.ipAllowlistEnabled, addressCount: data.allowedIps.length } : { oldKeyRevoked: true },
            });
        return res.json({ success: true, data });
    } catch (error) {
        return res.status(error.statusCode || 500).json({
            success: false,
            code: error.code || 'INTEGRATION_FAILED',
            error: error.statusCode
                ? error.message
                : 'تعذر تنفيذ طلب التكامل. حدّث الحالة قبل المحاولة مجدداً.',
        });
    }
};
router.get(paths(''), requireClientAuth, handle(service.getStatus));
router.get(paths('/overview'), requireClientAuth, async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try{return res.json({success:true,data:await require('../services/merchantIntegrationOverviewService').overview(await authorizedWorkspace(req),req)});}
    catch(error){return res.status(error.statusCode||503).json({success:false,error:error.statusCode?error.message:'تعذر التحقق من جاهزية التكاملات. أعد المحاولة.'});}
});
router.get(paths('/activity'), requireClientAuth, handle(service.getActivity));
router.get(['/client/integrations/api/guide.pdf', '/agent-portal/integrations/api/guide.pdf'], requireClientAuth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    try {
        const workspace = await authorizedWorkspace(req);
        const { buildIntegrationDocumentData, generateAccountIntegrationPdf, resolvePublicApiOrigin } = require('../services/accountIntegrationPdfService');
        const settings = await require('../models/Settings').findOne({}).lean() || {};
        const documentData = buildIntegrationDocumentData({
            account: workspace.entity,
            accountType: workspace.isCompany ? 'company' : 'agent',
            // Downloading documentation must never provision, reveal or rotate a credential.
            apiKey: '<API_KEY>',
            apiOrigin: resolvePublicApiOrigin(req),
            serviceRates: require('../utils/rateHelper').getCompanyRateConfig(workspace.entity, settings).effectiveRates
        });
        const pdf = await generateAccountIntegrationPdf(req.app, documentData);
        await logAction({
            action: 'MERCHANT_API_DOCUMENT_EXPORTED', req,
            performedById: workspace.actor._id, performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name, targetId: workspace.entity._id,
            targetModel: workspace.entityModel, result: 'نجاح', metadata: { credentialsIncluded: false }
        }).catch(() => {});
        const reference = String(documentData.account.accountCode).replace(/[^a-zA-Z0-9_-]/g, '').slice(0,40) || 'account';
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="api-integration-${workspace.isCompany ? 'company' : 'agent'}-${reference}.pdf"`);
        return res.send(pdf);
    } catch (error) {
        return res.status(error.statusCode || (error.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 500))
            .send(error.statusCode ? error.message : 'تعذر تحميل وثيقة API. أعد المحاولة لاحقًا.');
    }
});
router.get(['/client/integrations/api', '/agent-portal/integrations/api'], requireClientAuth, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        const workspace = await authorizedWorkspace(req);
        const status = await service.getStatus(workspace);
        return res.render('client/api', {
            portalBase: req.path.startsWith('/agent-portal') ? '/agent-portal' : '/client',
            csrfToken: res.locals.csrfToken || '', status,
            apiBase: require('../services/accountIntegrationPdfService').resolvePublicApiOrigin(req) + '/api/v1/merchant',
            webhookTheme: req.session.accountType === 'company' ? req.session.companyTheme : req.session.clientTheme
        });
    } catch (error) {
        return res.status(error.statusCode || 500).send(error.statusCode ? error.message : 'تعذر عرض صفحة API. أعد المحاولة.');
    }
});
router.post(paths('/rotate'), requireClientAuth, limited, handle(service.rotateKey));
router.post(paths('/revoke'), requireClientAuth, limited, handle(service.revokeKey));
router.post(paths('/ip-policy'), requireClientAuth, limited, handle(service.setIpPolicy));
router.post(
    ['/company/:id/integrations', '/user/:id/integrations'],
    requireAuth,
    requireMaster,
    async (req, res) => {
        try {
            if (tenantMode() === 'multi' && !req.tenant?._id)
                throw service.fail('TENANT_REQUIRED', 'تعذر تحديد المنشأة.', 403);
            const company = req.path.startsWith('/company/');
            const Model = company ? Company : User;
            const scope = adminAccountFindQuery(req, {
                _id: req.params.id,
                ...(company ? {} : { role: 'agent' }),
                status: { $ne: 'deleted' },
            });
            const flags = {
                apiEnabled: req.body.apiEnabled === 'on',
                webhooksEnabled: req.body.webhooksEnabled === 'on',
            };
            const revision = typeof req.body.revision === 'string' && /^\d+$/.test(req.body.revision) ? Number(req.body.revision) : req.body.revision;
            require('../utils/portalSettingsRevision').withRevision({}, revision);
            const row = await service.setAdminAccess(Model, scope, flags, revision, req.session.adminName || 'الإدارة');
            await logAction({
                action: 'MERCHANT_INTEGRATION_ACCESS_CHANGED',
                req,
                performedById: req.session.adminId,
                performedByModel: 'Admin',
                performedByName: req.session.adminName || 'الإدارة',
                targetId: row._id,
                targetModel: company ? 'ClientCompany' : 'User',
                result: 'ناجح',
                metadata: flags,
            });
            return res.redirect(
                `${company ? '/company/' : '/user/'}${row._id}?integrationsSaved=1#merchant-integration-access`
            );
        } catch (error) {
            return res
                .status(error.statusCode || 500)
                .send(error.statusCode ? error.message : 'تعذر حفظ إعدادات التكامل.');
        }
    }
);
module.exports = router;
