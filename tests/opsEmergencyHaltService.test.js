'use strict';

jest.mock('../models/Settings');
jest.mock('../models/Admin');
jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('bcryptjs', () => ({
    compare: jest.fn()
}));

const Settings = require('../models/Settings');
const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');
const { logAction } = require('../services/auditService');
const {
    CONFIRM_PHRASE,
    parseHaltEnable,
    setEmergencyHalt
} = require('../services/opsEmergencyHaltService');

const masterReq = () => ({
    session: {
        adminRole: 'master',
        adminId: '64b0000000000000000000aa',
        adminName: 'مدير النظام'
    }
});

describe('ops emergency halt', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('parses enable strictly so a missing body cannot halt or lift', () => {
        expect(parseHaltEnable(true)).toBe(true);
        expect(parseHaltEnable('true')).toBe(true);
        expect(parseHaltEnable(false)).toBe(false);
        expect(parseHaltEnable('false')).toBe(false);
        expect(parseHaltEnable(undefined)).toBeNull();
        expect(parseHaltEnable('1')).toBeNull();
        expect(parseHaltEnable('on')).toBeNull();
    });

    test('rejects non-master staff before touching settings', async () => {
        await expect(setEmergencyHalt({ session: { adminRole: 'admin' } }, {
            enable: true,
            confirmPhrase: CONFIRM_PHRASE,
            password: 'secret'
        })).rejects.toMatchObject({ status: 403 });
        expect(Admin.findById).not.toHaveBeenCalled();
        expect(Settings.findOne).not.toHaveBeenCalled();
    });

    test('requires the exact Arabic confirm phrase and a password', async () => {
        await expect(setEmergencyHalt(masterReq(), {
            enable: true,
            confirmPhrase: 'ايقاف',
            password: 'secret'
        })).rejects.toMatchObject({ status: 400 });

        await expect(setEmergencyHalt(masterReq(), {
            enable: true,
            confirmPhrase: CONFIRM_PHRASE,
            password: '   '
        })).rejects.toMatchObject({ status: 400 });
    });

    test('rejects a wrong password without flipping the halt flag', async () => {
        Admin.findById.mockReturnValue({
            select: () => Promise.resolve({ webPassword: 'hash', name: 'مدير', status: 'active' })
        });
        bcrypt.compare.mockResolvedValue(false);

        await expect(setEmergencyHalt(masterReq(), {
            enable: true,
            confirmPhrase: CONFIRM_PHRASE,
            password: 'wrong'
        })).rejects.toMatchObject({ status: 403 });
        expect(Settings.findOne).not.toHaveBeenCalled();
        expect(logAction).not.toHaveBeenCalled();
    });

    test('turns isManualClosed on with an audit trail and documented blast radius', async () => {
        const settings = {
            isManualClosed: false,
            closedMessage: '',
            save: jest.fn().mockResolvedValue(undefined)
        };
        Admin.findById.mockReturnValue({
            select: () => Promise.resolve({ webPassword: 'hash', name: 'مدير النظام', status: 'active' })
        });
        bcrypt.compare.mockResolvedValue(true);
        Settings.findOne
            .mockResolvedValueOnce(settings)
            .mockResolvedValueOnce(settings);

        const result = await setEmergencyHalt(masterReq(), {
            enable: true,
            confirmPhrase: CONFIRM_PHRASE,
            password: 'correct-password',
            reason: 'حملة احتيال'
        });

        expect(settings.isManualClosed).toBe(true);
        expect(settings.opsHaltReason).toBe('حملة احتيال');
        expect(settings.save).toHaveBeenCalled();
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'OPS_EMERGENCY_HALT_ON',
            severity: 'critical',
            required: true,
            metadata: expect.objectContaining({ blastRadius: 'new_outbound_transfers_only' })
        }));
        expect(result.active).toBe(true);
        expect(result.blastRadius).toBe('new_outbound_transfers_only');
    });

    test('lifts the halt without enabling SecurityState lockdown fields', async () => {
        const settings = {
            isManualClosed: true,
            opsHaltReason: 'حملة',
            save: jest.fn().mockResolvedValue(undefined)
        };
        Admin.findById.mockReturnValue({
            select: () => Promise.resolve({ webPassword: 'hash', name: 'مدير النظام', status: 'active' })
        });
        bcrypt.compare.mockResolvedValue(true);
        Settings.findOne
            .mockResolvedValueOnce(settings)
            .mockResolvedValueOnce({ isManualClosed: false });

        const result = await setEmergencyHalt(masterReq(), {
            enable: false,
            confirmPhrase: CONFIRM_PHRASE,
            password: 'correct-password'
        });

        expect(settings.isManualClosed).toBe(false);
        expect(settings.opsHaltAt).toBeNull();
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'OPS_EMERGENCY_HALT_OFF'
        }));
        expect(result.active).toBe(false);
        expect(JSON.stringify(settings)).not.toMatch(/lockdown/i);
    });
});
