'use strict';
const { rotateAgentPassword, setAgentStaffStatus } = require('../../services/agentCredentialService');
const User = require('../../models/User');
const AgentEmployee = require('../../models/AgentEmployee');
const SubAccount = require('../../models/SubAccount');
const ClientEmployee = require('../../models/ClientEmployee');
const Employee = require('../../models/Employee');
const Admin = require('../../models/Admin');
const { logAction } = require('../../services/auditService');
const { getAgentActor } = require('../../services/agentPortalContextService');
const { resolveAgentPermissions } = require('../../utils/agentPortalPolicy');
const { buildStaffPermissions, canEditStaffPermissions } = require('../../utils/agentStaffPermissions');
const canCreateAgentStaff = (actor) => resolveAgentPermissions(actor).canManageStaff;
const USERNAME_DOMAIN = '@ahram.com';
const isChecked = (value) => ['on', 'true', '1', 'yes'].includes(String(value || '').toLowerCase());

const normalizeUsername = (rawUsername) => {
    const base = String(rawUsername || '')
        .trim()
        .toLowerCase();
    const username = base.includes('@') ? base : `${base}${USERNAME_DOMAIN}`;
    if (!/^[a-z0-9_]{3,40}@ahram\.com$/.test(username)) {
        throw new Error('INVALID_USERNAME');
    }
    return username;
};

const assertUsernameAvailable = async (webUsername) => {
    const [user, subAccount, clientEmployee, agentEmployee, executor, admin] = await Promise.all([
        User.exists({ webUsername }),
        SubAccount.exists({ webUsername }),
        ClientEmployee.exists({ webUsername }),
        AgentEmployee.exists({ webUsername }),
        Employee.exists({ webUsername }),
        Admin.exists({ webUsername }),
    ]);

    if (user || subAccount || clientEmployee || agentEmployee || executor || admin) {
        throw new Error('USERNAME_TAKEN');
    }
};

exports.postAddStaff = async (req, res) => {
    const jsonRequest = req.baseUrl === '/agent-portal' && String(req.headers?.accept || '').includes('application/json');
    const respond = (code, status = 400) => jsonRequest
        ? res.status(code === 'created' ? 201 : status).json({ success: code === 'created', code })
        : res.redirect(`/client/staff?${code === 'created' ? 'staffSuccess' : 'staffError'}=${code}`);
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor))
            return respond('forbidden', 403);

        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const webPassword = String(req.body.webPassword || '');
        const role = String(req.body.role || 'employee').trim();
        const grantManagerAccess = isChecked(req.body.canManageAgent);
        const staffPermissions = req.body.permissionsMode ? buildStaffPermissions(req.body, actor, role) : undefined;
        if (!resolveAgentPermissions(actor).owner && !staffPermissions) return respond('forbidden', 403);

        if (!name || !phone || !webPassword || !['employee', 'accountant'].includes(role)) {
            return respond('missing');
        }
        if (webPassword.length < 8 || webPassword.length > 128)
            return respond('password');

        const webUsername = normalizeUsername(req.body.webUsername);
        await assertUsernameAvailable(webUsername);

        const created = await AgentEmployee.create({
            agentId: agent._id,
            tenantId: (req.tenant && req.tenant._id) || agent.tenantId || undefined,
            name,
            phone,
            webUsername,
            webPassword,
            role,
            status: 'active',
            canManageAgent: staffPermissions ? false : grantManagerAccess,
            canCreateAgentStaff: false,
            canViewAllReports: staffPermissions ? staffPermissions.canViewAllReports : role === 'accountant' || grantManagerAccess,
            ...(staffPermissions ? { staffPermissions } : {}),
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: created._id,
            targetModel: 'AgentEmployee',
            result: 'ناجح',
            metadata: { agentId: agent._id, role, canManageAgent: grantManagerAccess, webUsername },
        });

        return respond('created');
    } catch (error) {
        const code =
            error.message === 'USERNAME_TAKEN'
                ? 'username'
                : error.message === 'INVALID_USERNAME'
                  ? 'username_format'
                  : ['INVALID_PERMISSIONS', 'PERMISSION_ESCALATION'].includes(error.code) ? 'permissions' : 'server';
        console.error('[Agent Staff] create failed:', error.message);
        return respond(code, code === 'server' ? 500 : 400);
    }
};

exports.postUpdatePermissions = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor)) return res.status(403).json({ success: false, code: 'forbidden' });
        const target = await AgentEmployee.findOne({ _id: req.params.id, agentId: agent._id, status: { $ne: 'deleted' }, ...(agent.tenantId ? { tenantId: agent.tenantId } : {}) }).lean();
        if (!target || !canEditStaffPermissions(actor, target)) return res.status(403).json({ success: false, code: 'forbidden' });
        if (String(req.body.version) !== String(target.sessionVersion || 0)) return res.status(409).json({ success: false, code: 'changed' });
        const staffPermissions = buildStaffPermissions(req.body, actor, target.role);
        const updated = await AgentEmployee.findOneAndUpdate({ _id: target._id, agentId: agent._id, status: target.status, role: target.role, ...(target.sessionVersion === undefined ? { $or: [{sessionVersion:0},{sessionVersion:{$exists:false}}] } : {sessionVersion:target.sessionVersion}) }, {
            $set: { staffPermissions, canManageAgent: false, canCreateAgentStaff: false, canViewAllReports: staffPermissions.canViewAllReports },
            $inc: { sessionVersion: 1 },
            $unset: { refreshToken: '', otpCode: '', otpExpires: '', otpChallengeId: '', otpIssuedAt: '', otpAttempts: '' }
        }, { returnDocument: 'after', runValidators: true });
        if (!updated) return res.status(409).json({ success: false, code: 'changed' });
        await logAction({ action: 'USER_UPDATED', req, performedById: actor._id, performedByModel: actorModel, performedByName: actor.name, targetId: target._id, targetModel: 'AgentEmployee', result: 'ناجح', metadata: { agentId: agent._id, staffPermissions } });
        return res.json({ success: true, code: 'permissions_updated' });
    } catch (error) {
        const denied = ['INVALID_PERMISSIONS', 'PERMISSION_ESCALATION'].includes(error.code);
        return res.status(denied ? 403 : 500).json({ success: false, code: denied ? 'permissions' : 'server' });
    }
};

exports.postToggleStaff = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor))
            return res.status(403).redirect('/client/staff?staffError=forbidden');

        const target = await AgentEmployee.findOne({
            _id: req.params.id,
            agentId: agent._id,
            status: { $ne: 'deleted' },
        });
        if (!target || !canEditStaffPermissions(actor, target)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        const nextStatus = req.body.nextStatus || (target.status === 'active' ? 'banned' : 'active');
        await setAgentStaffStatus({
            staffId: target._id,
            agentId: agent._id,
            expectedStatus: target.status,
            nextStatus,
        });

        await logAction({
            action: 'USER_STATUS_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: target._id,
            targetModel: 'AgentEmployee',
            result: nextStatus,
            metadata: { agentId: agent._id, webUsername: target.webUsername },
        });

        return res.redirect('/client/staff?staffSuccess=status');
    } catch (error) {
        console.error('[Agent Staff] toggle failed:', error.message);
        return res.redirect('/client/staff?staffError=server');
    }
};

exports.postResetStaffPassword = async (req, res) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor))
            return res.status(403).redirect('/client/staff?staffError=forbidden');

        const newPassword = String(req.body.newPassword || '');
        if (newPassword.length < 8 || newPassword.length > 128)
            return res.redirect('/client/staff?staffError=password');

        const target = await AgentEmployee.findOne({
            _id: req.params.id,
            agentId: agent._id,
            status: { $ne: 'deleted' },
        });
        if (!target || !canEditStaffPermissions(actor, target)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        await rotateAgentPassword({
            accountModel: 'AgentEmployee',
            accountId: target._id,
            agentId: agent._id,
            newPassword,
        });

        await logAction({
            action: 'USER_PASSWORD_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: target._id,
            targetModel: 'AgentEmployee',
            result: 'ناجح',
            metadata: { agentId: agent._id, webUsername: target.webUsername },
        });

        return res.redirect('/client/staff?staffSuccess=password');
    } catch (error) {
        console.error('[Agent Staff] reset failed:', error.message);
        return res.redirect('/client/staff?staffError=server');
    }
};

exports.normalizeUsername = normalizeUsername;
