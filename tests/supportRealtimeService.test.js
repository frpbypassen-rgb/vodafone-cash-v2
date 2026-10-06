'use strict';

const { emitSupportTicketUpdate, SUPPORT_ADMIN_ROOM } = require('../services/supportRealtimeService');

test('support updates are emitted only to the authorized admin room', () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const req = { app: { get: jest.fn(() => ({ to })) } };
    expect(emitSupportTicketUpdate(req, { ticketId: 'ticket-1' })).toBe(true);
    expect(to).toHaveBeenCalledWith(SUPPORT_ADMIN_ROOM);
    expect(emit).toHaveBeenCalledWith('support:ticket-updated', { ticketId: 'ticket-1' });
});
