'use strict';
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const supportMessageDto = (ticket, message, index, basePath = '/client') => {
    const plain = message?.toObject ? message.toObject() : { ...message };
    if (plain.imageUrl) {
        plain.imageUrl = `${basePath}/api/support/tickets/${encodeURIComponent(String(ticket._id))}/images/${index}`;
    }
    return plain;
};

const getSupportIdentity = async (req) => {
    if (req.session.accountType === 'company') {
        return { account: await ClientEmployee.findById(req.session.clientId), entityType: 'client_company' };
    }
    if (req.session.accountType === 'agent_staff') {
        return { account: await AgentEmployee.findById(req.session.clientId), entityType: 'client_user' };
    }
    if (req.session.accountType === 'sub_client') {
        return { account: await SubAccount.findById(req.session.clientId), entityType: 'sub_client' };
    }
    return { account: await User.findById(req.session.clientId), entityType: 'client_user' };
};

const parseSupportImage = (imageBase64) => {
    if (!imageBase64) return null;
    const match = String(imageBase64).match(/^data:image\/(jpeg|jpg|png|webp);base64,([a-z0-9+/=\r\n]+)$/i);
    if (!match) throw new Error('INVALID_SUPPORT_IMAGE');
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > 4 * 1024 * 1024) throw new Error('INVALID_SUPPORT_IMAGE');
    return {
        buffer,
        extension: ['jpeg', 'jpg'].includes(match[1].toLowerCase()) ? '.jpg' : `.${match[1].toLowerCase()}`,
    };
};
module.exports = { supportMessageDto, getSupportIdentity, parseSupportImage };
