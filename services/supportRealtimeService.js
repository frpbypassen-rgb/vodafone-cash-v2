'use strict';

const SUPPORT_ADMIN_ROOM = 'admin:support';

const emitSupportTicketUpdate = (req, payload = {}) => {
    const io = req?.app?.get('io');
    if (!io) return false;
    io.to(SUPPORT_ADMIN_ROOM).emit('support:ticket-updated', payload);
    return true;
};

module.exports = { SUPPORT_ADMIN_ROOM, emitSupportTicketUpdate };
