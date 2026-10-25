'use strict';
const User = require('../../models/User');
const AgentEmployee = require('../../models/AgentEmployee');
const SubAccount = require('../../models/SubAccount');
const ClientEmployee = require('../../models/ClientEmployee');
const Employee = require('../../models/Employee');
const Admin = require('../../models/Admin');
const { logAction } = require('../../services/auditService');
const { getAgentActor } = require('../../services/agentPortalContextService');
const { resolveAgentPermissions } = require('../../utils/agentPortalPolicy');
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
    try {
        const { actor, agent, actorModel } = await getAgentActor(req);
        if (!canCreateAgentStaff(actor))
            return res.status(403).redirect('/client/staff?staffError=forbidden');

        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const webPassword = String(req.body.webPassword || '');
        const role = String(req.body.role || 'employee').trim();
        const grantManagerAccess = isChecked(req.body.canManageAgent);

        if (!name || !phone || !webPassword || !['employee', 'accountant'].includes(role)) {
            return res.redirect('/client/staff?staffError=missing');
        }
        if (webPassword.length < 8 || webPassword.length > 128)
            return res.redirect('/client/staff?staffError=password');

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
            canManageAgent: grantManagerAccess,
            canCreateAgentStaff: false,
            canViewAllReports: role === 'accountant' || grantManagerAccess,
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

        return res.redirect('/client/staff?staffSuccess=created');
    } catch (error) {
        const code =
            error.message === 'USERNAME_TAKEN'
                ? 'username'
                : error.message === 'INVALID_USERNAME'
                  ? 'username_format'
                  : 'server';
        console.error('[Agent Staff] create failed:', error.message);
        return res.redirect(`/client/staff?staffError=${code}`);
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
        if (!target || String(target._id) === String(actor._id)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        target.status = target.status === 'active' ? 'banned' : 'active';
        target.sessionVersion = Number(target.sessionVersion || 0) + 1;
        await target.save();

        await logAction({
            action: 'USER_STATUS_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: actorModel,
            performedByName: actor.name,
            targetId: target._id,
            targetModel: 'AgentEmployee',
            result: target.status,
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
        if (!target || String(target._id) === String(actor._id)) {
            return res.redirect('/client/staff?staffError=forbidden');
        }

        target.webPassword = newPassword;
        target.sessionVersion = Number(target.sessionVersion || 0) + 1;
        target.refreshToken = undefined;
        await target.save();

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
