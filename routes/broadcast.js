'use strict';

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const { requireAuth } = require('../middlewares/auth');
const { tenantScope, tenantWriteId } = require('../utils/tenantScope');

router.get('/broadcast', requireAuth, async (req, res) => {
    const scope = tenantScope(req);
    const [users, companies, executors] = await Promise.all([
        User.find({ ...scope, status: 'active' }).select('name phone webUsername').lean(),
        ClientCompany.find({ ...scope, status: 'active' }).select('name').lean(),
        ExecutorGroup.find({ ...scope, status: 'active' }).select('name').lean()
    ]);
    res.render('broadcast', { users, companies, executors, query: req.query });
});

router.post('/broadcast/send', requireAuth, async (req, res) => {
    const { target, specificUserId, specificCompanyId, specificExecutorId } = req.body;
    const message = String(req.body.message || '').trim().slice(0, 4000);
    const allowedTargets = new Set(['all', 'users', 'companies', 'employees', 'specific_user', 'specific_company', 'specific_executor']);
    if (!message || !allowedTargets.has(target)) return res.redirect('/broadcast?error=invalid');

    try {
        const scope = tenantScope(req);
        const recipients = new Set();
        if (target === 'all' || target === 'users') {
            const users = await User.find({ ...scope, status: 'active' }).select('phone webUsername').lean();
            users.forEach((user) => recipients.add(user.phone || user.webUsername));
        }
        if (target === 'all' || target === 'companies') {
            const employees = await ClientEmployee.find({ ...scope, status: 'active' }).select('webUsername').lean();
            employees.forEach((employee) => recipients.add(employee.webUsername));
        }
        if (target === 'all' || target === 'employees') {
            const employees = await Employee.find({ ...scope, status: 'active' }).select('webUsername').lean();
            employees.forEach((employee) => recipients.add(employee.webUsername));
        }
        if (target === 'specific_user') {
            const user = await User.findOne({ ...scope, _id: specificUserId, status: 'active' }).select('phone webUsername').lean();
            if (user) recipients.add(user.phone || user.webUsername);
        }
        if (target === 'specific_company') {
            const company = await ClientCompany.findOne({ ...scope, _id: specificCompanyId, status: 'active' }).select('_id').lean();
            if (company) {
                const employees = await ClientEmployee.find({ ...scope, companyId: company._id, status: 'active' }).select('webUsername').lean();
                employees.forEach((employee) => recipients.add(employee.webUsername));
            }
        }
        if (target === 'specific_executor') {
            const executor = await ExecutorGroup.findOne({ ...scope, _id: specificExecutorId, status: 'active' }).select('_id').lean();
            if (executor) {
                const employees = await Employee.find({ ...scope, groupId: executor._id, status: 'active' }).select('webUsername').lean();
                employees.forEach((employee) => recipients.add(employee.webUsername));
            }
        }

        const documents = [...recipients].filter(Boolean).map((userId) => ({
            tenantId: tenantWriteId(req), userId, audience: 'client',
            title: 'رسالة إدارية', message, type: 'system_alert'
        }));
        if (documents.length) await Notification.insertMany(documents, { ordered: false });
        return res.redirect(`/broadcast?success=true&sent=${documents.length}`);
    } catch (error) {
        console.error('[broadcast/send] failed:', error.message);
        return res.redirect('/broadcast?error=failed');
    }
});

module.exports = router;
