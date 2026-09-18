'use strict';

const mongoose = require('mongoose');
const OpsInternalNote = require('../models/OpsInternalNote');
const OpsWatchTask = require('../models/OpsWatchTask');
const Admin = require('../models/Admin');
const Transaction = require('../models/Transaction');
const { tenantScope, tenantWriteId } = require('../utils/tenantScope');
const { logAction } = require('./auditService');

const actor = (req) => ({
    id: String(req.session?.adminId || ''),
    name: req.session?.adminName || 'الإدارة'
});

const ensureTransaction = async (req, id) => {
    if (!mongoose.isValidObjectId(id)) return null;
    return Transaction.findOne({ _id: id, ...tenantScope(req) }).select('_id customId tenantId').lean();
};

const listNotes = async (req, transactionId) => {
    const tx = await ensureTransaction(req, transactionId);
    if (!tx) return null;
    const notes = await OpsInternalNote.find({ transactionId: tx._id, ...tenantScope(req) })
        .sort({ createdAt: -1 }).limit(50).lean();
    return notes.map((note) => ({
        id: String(note._id),
        body: note.body,
        authorName: note.authorName,
        createdAt: note.createdAt
    }));
};

const addNote = async (req, transactionId, body) => {
    const tx = await ensureTransaction(req, transactionId);
    if (!tx) return null;
    const text = String(body || '').trim().slice(0, 1000);
    if (!text) {
        const error = new Error('أدخل نص الملاحظة.');
        error.status = 400;
        throw error;
    }
    const who = actor(req);
    const note = await OpsInternalNote.create({
        transactionId: tx._id,
        tenantId: tenantWriteId(req) || tx.tenantId,
        body: text,
        authorId: who.id,
        authorName: who.name
    });
    await logAction({
        action: 'OPS_INTERNAL_NOTE',
        req,
        performedById: who.id || null,
        performedByModel: 'Admin',
        performedByName: who.name,
        targetId: tx._id,
        metadata: { reference: tx.customId, preview: text.slice(0, 80) },
        success: true
    });
    return {
        id: String(note._id),
        body: note.body,
        authorName: note.authorName,
        createdAt: note.createdAt
    };
};

const tasksForTransactions = async (req, ids) => {
    if (!ids.length) return new Map();
    const tasks = await OpsWatchTask.find({
        ...tenantScope(req),
        transactionId: { $in: ids },
        status: 'open'
    }).sort({ createdAt: -1 }).lean();
    const map = new Map();
    tasks.forEach((task) => {
        const key = String(task.transactionId);
        if (!map.has(key)) map.set(key, task);
    });
    return map;
};

const listOpenTasks = async (req, transactionId) => {
    const tx = await ensureTransaction(req, transactionId);
    if (!tx) return null;
    return OpsWatchTask.find({ transactionId: tx._id, ...tenantScope(req) }).sort({ createdAt: -1 }).limit(20).lean();
};

const assignTask = async (req, transactionId, { assigneeId, assigneeName, reason } = {}) => {
    const tx = await ensureTransaction(req, transactionId);
    if (!tx) return null;
    const who = actor(req);
    let name = String(assigneeName || '').trim();
    let color = OpsWatchTask.colorFor(assigneeId || name || who.id);
    if (assigneeId && mongoose.isValidObjectId(assigneeId)) {
        const staff = await Admin.findOne({ _id: assigneeId, status: { $ne: 'suspended' } }).select('name').lean();
        if (staff) {
            name = staff.name;
            color = OpsWatchTask.colorFor(staff._id);
        }
    }
    if (!name) name = who.name;
    await OpsWatchTask.updateMany(
        { transactionId: tx._id, status: 'open', ...tenantScope(req) },
        { $set: { status: 'resolved', resolvedAt: new Date(), resolvedByName: who.name } }
    );
    const task = await OpsWatchTask.create({
        transactionId: tx._id,
        tenantId: tenantWriteId(req) || tx.tenantId,
        status: 'open',
        reason: String(reason || 'مراجعة عملية مشبوهة').slice(0, 300),
        assigneeId: String(assigneeId || who.id),
        assigneeName: name,
        assigneeColor: color,
        createdById: who.id,
        createdByName: who.name
    });
    await logAction({
        action: 'OPS_WATCH_TASK_ASSIGNED',
        req,
        performedById: who.id || null,
        performedByModel: 'Admin',
        performedByName: who.name,
        targetId: tx._id,
        metadata: { reference: tx.customId, assigneeName: name },
        success: true
    });
    return task;
};

const resolveTask = async (req, taskId) => {
    if (!mongoose.isValidObjectId(taskId)) return null;
    const who = actor(req);
    const task = await OpsWatchTask.findOne({ _id: taskId, ...tenantScope(req), status: 'open' });
    if (!task) return null;
    task.status = 'resolved';
    task.resolvedAt = new Date();
    task.resolvedByName = who.name;
    await task.save();
    await logAction({
        action: 'OPS_WATCH_TASK_RESOLVED',
        req,
        performedById: who.id || null,
        performedByModel: 'Admin',
        performedByName: who.name,
        targetId: task.transactionId,
        metadata: { taskId: String(task._id) },
        success: true
    });
    return task;
};

const listStaff = async () => {
    const admins = await Admin.find({ status: { $ne: 'suspended' } }).select('name role').sort({ name: 1 }).limit(50).lean();
    return admins.map((admin) => ({
        id: String(admin._id),
        name: admin.name,
        role: admin.role,
        color: OpsWatchTask.colorFor(admin._id)
    }));
};

module.exports = {
    addNote,
    assignTask,
    listNotes,
    listOpenTasks,
    listStaff,
    resolveTask,
    tasksForTransactions
};
