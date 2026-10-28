'use strict';
const crypto = require('crypto');
const Subscription = require('../models/CompanyReportEmail');
const Delivery = require('../models/CompanyReportEmailDelivery');
const Company = require('../models/ClientCompany');
const CompanyEmployee = require('../models/ClientEmployee');
const { resolveCompanyAccess, toPortalPermissions } = require('./companyAccessService');
const { buildWorkspaceResult } = require('./portalWorkspace/factory');
const { canReceiveCompanyStatement } = require('../utils/companyReportEmailAccess');
const { previousDay, createStatementPdf } = require('./companyDailyStatementService');
const { systemDateParts, systemDayEnd } = require('../config/systemTime');
const { sendStatement, configured } = require('./companyReportEmailMailer');
const { ownerFilter, fail } = require('./companyReportEmailService');
const logger = require('../utils/logger');

const loadWorkspace = async subscription => {
    const actor = await CompanyEmployee.findById(subscription.actorId).lean();
    const company = actor && await Company.findById(actor.companyId).lean();
    if(subscription.actorModel !== 'ClientEmployee' || !actor || !company || actor.status !== 'active' || company.status !== 'active'
        || String(company._id) !== String(subscription.companyId)
        || String(company.tenantId || '') !== String(subscription.tenantId || '')
        || String(actor.tenantId || '') !== String(company.tenantId || '')) throw fail('REPORT_FORBIDDEN','REPORT_FORBIDDEN',403);
    const permissions=toPortalPermissions(resolveCompanyAccess(actor));
    const workspace=buildWorkspaceResult({type:'company',actor,entity:company,actorModel:'ClientEmployee',entityModel:'ClientCompany',permissions});
    if(!canReceiveCompanyStatement(workspace)) throw fail('REPORT_FORBIDDEN','REPORT_FORBIDDEN',403);
    return workspace;
};
const dueDay = (now = new Date()) => {
    const parts = systemDateParts(now);
    return Number(parts.hour) * 60 + Number(parts.minute) >= 5 ? previousDay(now) : null;
};
const enqueue = async (subscription, day, kind = 'daily') => {
    const key = `${subscription._id}:${day}:${kind === 'daily' ? 'daily' : crypto.randomUUID()}`;
    try { await Delivery.updateOne({ key }, { $setOnInsert: { key, subscriptionId: subscription._id, day, kind } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    return Delivery.findOne({ key }).lean();
};
const deliver = async (id, now = new Date()) => {
    const job = await Delivery.findOneAndUpdate({ _id: id, status: { $in: ['pending', 'failed'] }, retryAt: { $lte: now }, attempts: { $lt: 3 } }, {
        $set: { status: 'processing', lockedAt: now }, $inc: { attempts: 1 },
    }, { returnDocument: 'after' }).lean();
    if (!job) return { status: 'already_claimed' };
    let smtpStarted = false;
    try {
        const subscription = await Subscription.findById(job.subscriptionId).lean();
        if (!subscription?.enabled || !subscription.verifiedAt || !subscription.email) throw fail('REPORT_DISABLED', 'REPORT_DISABLED', 403);
        const workspace = await loadWorkspace(subscription);
        const pdf = await createStatementPdf(workspace, job.day);
        // Recheck consent, address and permissions after the potentially slow PDF render.
        const current = await Subscription.findById(subscription._id).lean();
        if (!current?.enabled || current.email !== subscription.email || String(current.verifiedAt) !== String(subscription.verifiedAt)) throw fail('REPORT_DISABLED', 'REPORT_DISABLED', 403);
        const freshWorkspace = await loadWorkspace(current);
        if (JSON.stringify(freshWorkspace.permissions) !== JSON.stringify(workspace.permissions)) throw fail('REPORT_FORBIDDEN', 'REPORT_FORBIDDEN', 403);
        smtpStarted = true;
        await sendStatement({ email: current.email, day: job.day, pdf, test: job.kind === 'test', accountName:freshWorkspace.entity.name });
        await Delivery.updateOne({ _id: job._id, status: 'processing' }, { $set: { status: 'sent', sentAt: new Date() }, $unset: { errorCode: 1 } });
        await Subscription.updateOne({ _id: current._id, email: current.email, verifiedAt: current.verifiedAt }, { $set: { lastSentAt: new Date(), lastReportDay: job.day, lastDeliveryStatus: job.kind === 'test' ? 'test_sent' : 'sent' } });
        return { status: 'sent' };
    } catch (error) {
        const cancelled = error.statusCode === 403;
        const definiteSmtpFailure = ['EAUTH', 'EENVELOPE', 'ECONNECTION', 'ENOTFOUND', 'ECONNREFUSED', 'SMTP_UNAVAILABLE'].includes(error.code);
        const status = cancelled ? 'cancelled' : smtpStarted && !definiteSmtpFailure ? 'uncertain' : 'failed';
        const errorCode = cancelled ? 'REPORT_DISABLED_OR_FORBIDDEN' : smtpStarted ? 'EMAIL_DELIVERY_FAILED' : 'REPORT_GENERATION_FAILED';
        await Delivery.updateOne({ _id: job._id, status: 'processing' }, { $set: { status, errorCode, retryAt: new Date(now.getTime() + 900000) } });
        await Subscription.updateOne({ _id: job.subscriptionId }, { $set: { lastDeliveryStatus: status === 'failed' && job.attempts < 3 ? 'retrying' : status } });
        logger.warn('Company statement delivery did not complete', { deliveryId: String(job._id), status, errorCode });
        return { status };
    }
};
const sendTest = async (workspace, now = new Date()) => {
    const subscription = await Subscription.findOneAndUpdate({ ...ownerFilter(workspace), enabled: true, verifiedAt: { $ne: null }, testAfter: { $lte: now } }, {
        $set: { testAfter: new Date(now.getTime() + 600000) },
    }, { returnDocument: 'after' }).lean();
    if (!subscription) throw fail('TEST_NOT_AVAILABLE', 'فعّل البريد أولاً، وانتظر 10 دقائق بين كل كشف تجريبي وآخر.', 429);
    const job = await enqueue(subscription, previousDay(now), 'test');
    const result = await deliver(job._id, now);
    if (result.status !== 'sent') throw fail('TEST_SEND_FAILED', 'تعذر تأكيد الإرسال. راجع حالة الإرسال لاحقاً.', 503);
    return result;
};
let timer = null, running = false;
const tick = async (now = new Date()) => {
    if (running || !configured()) return;
    running = true;
    try {
        // A crash during SMTP is ambiguous. Never automatically resend such a message.
        await Delivery.updateMany({ status: 'processing', lockedAt: { $lt: new Date(now.getTime() - 1800000) } }, { $set: { status: 'uncertain', errorCode: 'WORKER_INTERRUPTED' } });
        const day = dueDay(now);
        if (day) {
            for await (const subscription of Subscription.find({ enabled: true, verifiedAt: { $lte: systemDayEnd(day) } }).cursor()) {
                await enqueue(subscription, day);
            }
        }
        for await (const job of Delivery.find({ status: { $in: ['pending', 'failed'] }, retryAt: { $lte: now }, attempts: { $lt: 3 } }).sort({ createdAt: 1 }).cursor()) {
            await deliver(job._id, now);
        }
    } finally { running = false; }
};
const start = async () => {
    if (timer) return;
    await Promise.all([Subscription.createIndexes(), Delivery.createIndexes()]);
    if (process.env.NODE_ENV !== 'production' || ['false', '0', 'off'].includes(String(process.env.COMPANY_REPORT_EMAIL_ENABLED).toLowerCase())) return;
    const run = () => tick().catch(() => logger.error('Company daily statement worker failed'));
    timer = setInterval(run, 60000);
    timer.unref();
    void run();
};
const stop = () => { if (timer) clearInterval(timer); timer = null; };
module.exports = { loadWorkspace, dueDay, enqueue, deliver, sendTest, tick, start, stop };
