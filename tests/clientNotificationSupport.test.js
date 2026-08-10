'use strict';

jest.mock('../models/Notification', () => ({ create: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/ClientCompany', () => ({ findById: jest.fn() }));
jest.mock('../models/ClientEmployee', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ findById: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findById: jest.fn() }));

const Notification = require('../models/Notification');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const {
    createSupportReplyNotifications,
    resolveSupportTicketNotificationUserIds
} = require('../services/clientNotificationService');

const leanResult = (value) => ({
    select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(value)
    })
});

describe('support reply notifications', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        User.findById.mockReturnValue(leanResult(null));
        ClientEmployee.findById.mockReturnValue(leanResult(null));
        SubAccount.findById.mockReturnValue(leanResult(null));
        AgentEmployee.findById.mockReturnValue(leanResult(null));
        Notification.create.mockResolvedValue({ _id: 'notification-1' });
    });

    test('resolves the correct signed-in identifiers for an individual client ticket', async () => {
        User.findById.mockReturnValue(leanResult({
            _id: 'user-1',
            phone: '0912345678',
            webUsername: 'customer.user'
        }));

        const userIds = await resolveSupportTicketNotificationUserIds({
            entityType: 'client_user',
            entityId: 'user-1',
            phone: '0912345678'
        });

        expect(userIds).toEqual(expect.arrayContaining([
            '0912345678',
            'customer.user',
            'user-1'
        ]));
    });

    test('creates portal notifications for every company support recipient identifier', async () => {
        ClientEmployee.findById.mockReturnValue(leanResult({
            _id: 'employee-1',
            phone: '0922222222',
            webUsername: 'company.manager',
            companyId: 'company-1'
        }));

        const ticket = {
            _id: 'ticket-1',
            entityType: 'client_company',
            entityId: 'employee-1',
            phone: '0922222222'
        };

        const notifications = await createSupportReplyNotifications({ ticket, channel: 'whatsapp' });

        expect(notifications).toHaveLength(4);
        expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
            audience: 'client',
            targetModel: 'SupportTicket',
            targetId: 'ticket-1',
            type: 'support_reply',
            metadata: expect.objectContaining({ ticketId: 'ticket-1', channel: 'whatsapp' })
        }));
    });
});
