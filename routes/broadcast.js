const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const { requireAuth } = require('../middlewares/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/broadcast', requireAuth, async (req, res) => {
    const users = await User.find({ status: 'active' }); const companies = await ClientCompany.find({ status: 'active' }); const executors = await ExecutorGroup.find({ status: 'active' }); res.render('broadcast', { users, companies, executors, query: req.query });
});

router.post('/broadcast/send', requireAuth, upload.single('imageFile'), async (req, res) => {
    const { target, message, specificUserId, specificCompanyId, specificExecutorId } = req.body;
    try {
        const sendMsg = async (userId, text) => {
            if (!userId) return;
            try { 
                await Notification.create({
                    userId: userId,
                    title: 'رسالة إدارية',
                    message: text,
                    type: 'system_alert'
                });
            } catch (e) {}
        };

        if (target === 'all' || target === 'users') { const users = await User.find({ status: 'active' }); for (const u of users) await sendMsg(u.phone || u.webUsername, message); }
        if (target === 'all' || target === 'companies') { const clientEmps = await ClientEmployee.find({ status: 'active' }); for (const emp of clientEmps) await sendMsg(emp.webUsername, message); }
        if (target === 'all' || target === 'employees') { const execEmps = await Employee.find({ status: 'active' }); for (const emp of execEmps) await sendMsg(emp.webUsername, message); }
        if (target === 'specific_user') await sendMsg(specificUserId, message);
        if (target === 'specific_company') { const emps = await ClientEmployee.find({ companyId: specificCompanyId, status: 'active' }); for (const emp of emps) await sendMsg(emp.webUsername, message); }
        if (target === 'specific_executor') { const emps = await Employee.find({ groupId: specificExecutorId, status: 'active' }); for (const emp of emps) await sendMsg(emp.webUsername, message); }
        res.redirect('/broadcast?success=true');
    } catch (e) { res.redirect('/broadcast?error=failed'); }
});

module.exports = router;
