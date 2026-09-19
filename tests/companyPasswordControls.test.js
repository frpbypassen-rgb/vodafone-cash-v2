'use strict';

jest.mock('../services/auditService', () => ({
    logAction: jest.fn(async (payload) => payload)
}));

const bcrypt = require('bcryptjs');
const { logAction } = require('../services/auditService');
const {
    confirmStaffPasswordReset,
    applyOwnPasswordChange,
    applyStaffPasswordReset,
    assertAuditSafe
} = require('../services/companyPasswordService');
const { resolveCompanyAccess } = require('../services/companyAccessService');
const clientCompanyController = require('../controllers/clientCompanyController');

const hash = (value) => bcrypt.hashSync(value, 4);

describe('company password controls', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('changing own password requires the current password and invalidates other sessions', async () => {
        const actor = {
            _id: 'owner-1',
            name: 'مالك',
            webPassword: hash('OldPass12'),
            sessionVersion: 2,
            mustChangePassword: true,
            save: jest.fn(async function save() { return this; })
        };
        await expect(applyOwnPasswordChange({
            actor: { ...actor, save: actor.save },
            currentPassword: 'wrong',
            newPassword: 'NewPass12',
            passwordConfirm: 'NewPass12',
            req: { method: 'POST', originalUrl: '/client/settings/password' }
        })).rejects.toMatchObject({ code: 'CURRENT_PASSWORD' });

        const result = await applyOwnPasswordChange({
            actor,
            currentPassword: 'OldPass12',
            newPassword: 'NewPass12',
            passwordConfirm: 'NewPass12',
            req: { method: 'POST', originalUrl: '/client/settings/password' }
        });
        expect(result.sessionVersion).toBe(3);
        expect(actor.mustChangePassword).toBe(false);
        expect(actor.save).toHaveBeenCalled();
        const audit = logAction.mock.calls[0][0];
        expect(JSON.stringify(audit)).not.toMatch(/NewPass12|OldPass12/);
        expect(audit.metadata.selfService).toBe(true);
    });

    test('team reset needs a strong confirm, blocks self, and never logs the password', async () => {
        const ownerAccess = resolveCompanyAccess({ role: 'owner' });
        const target = {
            _id: 'emp-1',
            webUsername: 'emp@ahram.com',
            role: 'employee',
            sessionVersion: 0,
            save: jest.fn(async function save() { return this; })
        };
        expect(() => confirmStaffPasswordReset({
            confirmPhrase: 'reset',
            confirmUsername: 'emp@ahram.com',
            targetUsername: 'emp@ahram.com'
        })).toThrow('RESET_CONFIRM_REQUIRED');

        await expect(applyStaffPasswordReset({
            actor: { _id: 'emp-1', name: 'نفسه' },
            access: ownerAccess,
            company: { _id: 'co-1' },
            target,
            newPassword: 'TempPass12',
            confirmPhrase: 'RESET',
            confirmUsername: 'emp@ahram.com',
            req: {}
        })).rejects.toMatchObject({ code: 'SELF_TARGET_FORBIDDEN' });

        const other = { ...target, _id: 'emp-2', save: jest.fn(async function save() { return this; }) };
        const result = await applyStaffPasswordReset({
            actor: { _id: 'owner-1', name: 'مالك' },
            access: ownerAccess,
            company: { _id: 'co-1' },
            target: other,
            newPassword: 'TempPass12',
            confirmPhrase: 'RESET',
            confirmUsername: 'emp@ahram.com',
            req: { method: 'POST', originalUrl: '/client/company/staff/emp-2/password' }
        });
        expect(result.mustChangePassword).toBe(true);
        expect(other.sessionVersion).toBe(1);
        const audit = logAction.mock.calls[0][0];
        expect(JSON.stringify(audit)).not.toMatch(/TempPass12/);
        expect(audit.metadata.temporaryPassword).toBe(true);
        expect(() => assertAuditSafe({ metadata: { password: 'x' } })).toThrow('PASSWORD_LEAK_FORBIDDEN');
    });

    test('accountant cannot escalate via a crafted team-reset request', async () => {
        const req = {
            session: { accountType: 'company', isClientLoggedIn: true, clientId: 'acc-1', clientSessionVersion: 0 },
            body: { newPassword: 'Hacked12', confirmPhrase: 'RESET', confirmUsername: 'emp@ahram.com' },
            params: { id: 'emp-1' }
        };
        const res = {
            status: jest.fn(() => res),
            redirect: jest.fn(() => res)
        };
        const ClientEmployee = require('../models/ClientEmployee');
        const ClientCompany = require('../models/ClientCompany');
        ClientEmployee.findById = jest.fn(async () => ({
            _id: 'acc-1',
            companyId: 'co-1',
            status: 'active',
            role: 'accountant',
            sessionVersion: 0,
            name: 'محاسب'
        }));
        ClientCompany.findById = jest.fn(async () => ({ _id: 'co-1', status: 'active' }));
        ClientEmployee.findOne = jest.fn(async () => ({
            _id: 'emp-1',
            companyId: 'co-1',
            role: 'employee',
            webUsername: 'emp@ahram.com'
        }));

        await clientCompanyController.postResetStaffPassword(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.redirect).toHaveBeenCalledWith('/client/staff?staffError=forbidden');
    });
});
