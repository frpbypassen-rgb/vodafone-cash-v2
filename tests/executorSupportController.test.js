'use strict';

jest.mock('../models/Employee', () => ({ findById: jest.fn() }));
jest.mock('../models/Admin', () => ({ find: jest.fn() }));
jest.mock('../models/SupportTicket', () => ({ findOne: jest.fn() }));
jest.mock('../utils/logger', () => ({ error: jest.fn() }));

const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const SupportTicket = require('../models/SupportTicket');
const logger = require('../utils/logger');
const controller = require('../controllers/executorSupportController');

describe('legacy executor support error boundary', () => {
    beforeEach(() => jest.clearAllMocks());

    const req = () => ({ session: { executorId: 'employee-1' }, body: { text: 'test message' } });
    const res = () => ({ json: jest.fn() });

    test('does not expose a failed support write', async () => {
        Employee.findById.mockReturnValueOnce({ populate: jest.fn().mockRejectedValue(new Error('mongodb://user:secret@host')) });
        const response = res();
        await controller.postSupportMessages(req(), response);
        expect(response.json).toHaveBeenCalledWith({ success: false, error: 'تعذر إرسال رسالة الدعم.' });
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test('a failed admin notification does not report an already saved message as failed', async () => {
        Employee.findById.mockReturnValueOnce({ populate: jest.fn().mockResolvedValue({ _id: 'employee-1', name: 'test' }) });
        const ticket = { messages: [], save: jest.fn().mockResolvedValue(true) };
        SupportTicket.findOne.mockResolvedValueOnce(ticket);
        Admin.find.mockRejectedValueOnce(new Error('mongodb://user:secret@host'));
        const response = res();
        await controller.postSupportMessages(req(), response);
        expect(ticket.save).toHaveBeenCalledTimes(1);
        expect(response.json).toHaveBeenCalledWith({ success: true, message: ticket.messages[0] });
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });
});
