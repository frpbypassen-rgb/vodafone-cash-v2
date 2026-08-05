'use strict';

jest.mock('../models/RegistrationRequest', () => ({ findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/ClientEmployee', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Employee', () => ({ findOne: jest.fn() }));
jest.mock('../models/Admin', () => ({ findOne: jest.fn() }));

const RegistrationRequest = require('../models/RegistrationRequest');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const {
    checkRegistrationIdentityAvailability,
    prepareRegistrationIdentityForApproval
} = require('../services/registrationIdentityService');

const models = [User, SubAccount, ClientEmployee, AgentEmployee, Employee, Admin];
const isDeletedQuery = (query) => query?.$and?.some((condition) => condition.status === 'deleted');

describe('Registration identity lifecycle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        RegistrationRequest.findOne.mockResolvedValue(null);
        models.forEach((Model) => Model.findOne.mockResolvedValue(null));
        [User, SubAccount, ClientEmployee, AgentEmployee].forEach((Model) => {
            Model.updateOne.mockResolvedValue({ modifiedCount: 1 });
        });
    });

    test('blocks registration while the same identity belongs to an active account', async () => {
        User.findOne.mockImplementation(async (query) => (
            isDeletedQuery(query) ? null : { _id: 'active-1', status: 'active', phone: '0911111111' }
        ));

        const result = await checkRegistrationIdentityAvailability({
            phone: '0911111111',
            username: 'active_user@ahram.com'
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('active');
    });

    test('allows a deleted identity and adds an admin review note', async () => {
        const deletedUser = {
            _id: 'deleted-1',
            name: 'عميل محذوف',
            status: 'deleted',
            phone: '0922222222',
            webUsername: 'deleted_user@ahram.com',
            deletedAt: new Date('2026-08-01T12:00:00Z')
        };
        User.findOne.mockImplementation(async (query) => (isDeletedQuery(query) ? deletedUser : null));

        const result = await checkRegistrationIdentityAvailability({
            phone: deletedUser.phone,
            username: deletedUser.webUsername
        });

        expect(result.success).toBe(true);
        expect(result.requestMetadata).toEqual(expect.objectContaining({
            wasPreviouslyDeleted: true,
            adminNotes: expect.stringContaining('سبق حذف حساب')
        }));
        expect(result.requestMetadata.previousDeletedAccounts).toHaveLength(1);
    });

    test('blocks a second request while an earlier request is pending', async () => {
        RegistrationRequest.findOne.mockResolvedValue({ _id: 'request-1', refCode: 'REG-2608-1234' });

        const result = await checkRegistrationIdentityAvailability({
            phone: '0933333333',
            username: 'pending_user@ahram.com'
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('pending');
        expect(result.message).toContain('REG-2608-1234');
    });

    test('archives colliding credentials before approving the replacement account', async () => {
        const deletedUser = {
            _id: 'deleted-4',
            name: 'عميل محذوف',
            status: 'deleted',
            phone: '0944444444',
            webUsername: 'replacement@ahram.com'
        };
        User.findOne.mockImplementation(async (query) => (isDeletedQuery(query) ? deletedUser : null));

        await prepareRegistrationIdentityForApproval({
            phone: deletedUser.phone,
            username: deletedUser.webUsername,
            excludeRequestId: 'request-4'
        });

        expect(User.updateOne).toHaveBeenCalledTimes(1);
        expect(User.updateOne).toHaveBeenCalledWith(
            { _id: deletedUser._id, status: 'deleted' },
            { $set: expect.objectContaining({
                'deletedCredentials.phone': deletedUser.phone,
                'deletedCredentials.webUsername': deletedUser.webUsername,
                phone: expect.stringContaining('deleted-user-'),
                webUsername: expect.stringContaining('@archive.invalid')
            }) },
            { strict: false }
        );
    });
});
