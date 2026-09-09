'use strict';

const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const PointOfSaleCustomer = require('../models/PointOfSaleCustomer');
const PointOfSaleSettlement = require('../models/PointOfSaleSettlement');
const { requestSettlement, confirmSettlement, cancelSettlement } = require('../services/pointOfSaleSettlementService');

const router = express.Router();

const apiError = (res, error) => res.status(error.statusCode || 500).json({
    success: false,
    code: error.code || 'POS_API_ERROR',
    message: error.statusCode ? error.message : 'تعذر تنفيذ طلب نقطة البيع.'
});

const posApiAuth = async (req, res, next) => {
    try {
        const apiKey = String(req.get('x-api-key') || '').trim();
        if (!apiKey) return res.status(401).json({ success: false, code: 'API_KEY_REQUIRED', message: 'مفتاح x-api-key مطلوب.' });
        const agent = await User.findOne({ apiToken: apiKey, role: 'agent', status: 'active' }).select('+apiToken').lean();
        if (!agent) return res.status(401).json({ success: false, code: 'INVALID_API_KEY', message: 'مفتاح API غير صالح أو الحساب موقوف.' });
        req.posAgent = agent;
        next();
    } catch (error) {
        apiError(res, error);
    }
};

const customerDto = (customer) => ({
    id: String(customer._id), name: customer.name, phone: customer.phone,
    receipt_phone: customer.receiptPhone || customer.phone,
    balance_lyd: Number(customer.balance || 0), reserved_lyd: Number(customer.reservedBalance || 0),
    available_lyd: Number((Number(customer.balance || 0) - Number(customer.reservedBalance || 0)).toFixed(3)),
    status: customer.status,
    external_link: customer.externalLink?.externalCustomerId ? {
        external_customer_id: customer.externalLink.externalCustomerId,
        external_customer_name: customer.externalLink.externalCustomerName || null,
        linked_at: customer.externalLink.linkedAt || null
    } : null
});

const settlementDto = (settlement) => ({
    reference: settlement.reference, customer_id: String(settlement.customerId),
    external_customer_id: settlement.externalCustomerId, amount_lyd: settlement.amount,
    type: settlement.type, status: settlement.status, external_reference: settlement.externalReference || null,
    balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
    created_at: settlement.createdAt, completed_at: settlement.status === 'completed' ? settlement.updatedAt : null,
    trace: settlement.trace || []
});

router.get('/customers', posApiAuth, async (req, res) => {
    try {
        const search = String(req.query.search || '').trim().slice(0, 80);
        const filter = { ownerAgentId: req.posAgent._id, status: { $ne: 'suspended' } };
        if (search) {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [{ name: { $regex: escaped, $options: 'i' } }, { phone: { $regex: escaped, $options: 'i' } }];
        }
        const customers = await PointOfSaleCustomer.find(filter).sort({ name: 1 }).limit(100).lean();
        res.json({ success: true, data: customers.map(customerDto) });
    } catch (error) { apiError(res, error); }
});

router.post('/customers', posApiAuth, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const receiptPhone = String(req.body.receipt_phone || phone).trim();
        if (name.length < 2 || phone.length < 5 || phone.length > 30 || receiptPhone.length < 5 || receiptPhone.length > 30) {
            return res.status(400).json({ success: false, code: 'INVALID_CUSTOMER', message: 'اسم العميل ورقم الهاتف مطلوبان بصيغة صحيحة.' });
        }
        const customer = await PointOfSaleCustomer.create({
            ownerAgentId: req.posAgent._id, tenantId: req.posAgent.tenantId || undefined, name, phone, receiptPhone
        });
        res.status(201).json({ success: true, data: customerDto(customer) });
    } catch (error) { apiError(res, error); }
});

router.patch('/customers/:customerId/external-link', posApiAuth, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.customerId)) return res.status(400).json({ success: false, code: 'INVALID_CUSTOMER_ID', message: 'معرف العميل غير صالح.' });
        const externalCustomerId = String(req.body.external_customer_id || '').trim();
        const externalCustomerName = String(req.body.external_customer_name || '').trim().slice(0, 120);
        if (!externalCustomerId || externalCustomerId.length > 120) return res.status(400).json({ success: false, code: 'INVALID_EXTERNAL_CUSTOMER', message: 'معرف العميل الخارجي مطلوب.' });
        const linkedElsewhere = await PointOfSaleCustomer.exists({
            ownerAgentId: req.posAgent._id,
            _id: { $ne: req.params.customerId },
            'externalLink.externalCustomerId': externalCustomerId
        });
        if (linkedElsewhere) return res.status(409).json({ success: false, code: 'EXTERNAL_CUSTOMER_ALREADY_LINKED', message: 'هذا العميل الخارجي مرتبط بالفعل بعميل آخر في نقطة البيع.' });
        const customer = await PointOfSaleCustomer.findOneAndUpdate(
            { _id: req.params.customerId, ownerAgentId: req.posAgent._id },
            { $set: { externalLink: { externalCustomerId, externalCustomerName, linkedAt: new Date(), linkedBy: 'POS API' } } },
            { new: true }
        );
        if (!customer) return res.status(404).json({ success: false, code: 'POS_CUSTOMER_NOT_FOUND', message: 'العميل غير موجود.' });
        res.json({ success: true, data: customerDto(customer) });
    } catch (error) { apiError(res, error); }
});

router.post('/customers/:customerId/settlements', posApiAuth, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.customerId)) return res.status(400).json({ success: false, code: 'INVALID_CUSTOMER_ID', message: 'معرف العميل غير صالح.' });
        const result = await requestSettlement({
            ownerAgentId: req.posAgent._id, tenantId: req.posAgent.tenantId || undefined,
            customerId: req.params.customerId, externalCustomerId: req.body.external_customer_id,
            type: req.body.type, amount: req.body.amount, idempotencyKey: req.get('idempotency-key'), actor: 'POS integration API'
        });
        res.status(result.replayed ? 200 : 202).json({ success: true, replayed: result.replayed, data: settlementDto(result.settlement) });
    } catch (error) { apiError(res, error); }
});

router.get('/settlements/:reference', posApiAuth, async (req, res) => {
    try {
        const settlement = await PointOfSaleSettlement.findOne({ ownerAgentId: req.posAgent._id, reference: req.params.reference }).lean();
        if (!settlement) return res.status(404).json({ success: false, code: 'SETTLEMENT_NOT_FOUND', message: 'التسوية غير موجودة.' });
        res.json({ success: true, data: settlementDto(settlement) });
    } catch (error) { apiError(res, error); }
});

router.post('/settlements/:reference/confirm', posApiAuth, async (req, res) => {
    try {
        const result = await confirmSettlement({ ownerAgentId: req.posAgent._id, reference: req.params.reference, externalReference: req.body.external_reference, actor: 'POS integration API' });
        res.json({ success: true, replayed: result.replayed, data: settlementDto(result.settlement) });
    } catch (error) { apiError(res, error); }
});

router.post('/settlements/:reference/cancel', posApiAuth, async (req, res) => {
    try {
        const result = await cancelSettlement({ ownerAgentId: req.posAgent._id, reference: req.params.reference, reason: req.body.reason, actor: 'POS integration API' });
        res.json({ success: true, replayed: result.replayed, data: settlementDto(result.settlement) });
    } catch (error) { apiError(res, error); }
});

module.exports = router;
