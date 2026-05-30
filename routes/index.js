const express = require('express');
const router = express.Router();
const axios = require('axios'); 
const fs = require('fs');
const path = require('path');
const { Telegram } = require('telegraf');
const bcrypt = require('bcryptjs'); 

const Admin = require('../models/Admin');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientBot = require('../models/ClientBot');
const ExecutorBot = require('../models/ExecutorBot');
const Transaction = require('../models/Transaction');
const { isAuthenticated } = require('../middlewares/auth');

// =======================================================
// 👑 تسجيل دخول الإدارة المركزية
// =======================================================
router.get('/login', (req, res) => {
    if (req.session.isLoggedIn || req.session.adminId || req.session.adminRole === 'master') return res.redirect('/');
    res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) return res.render('login', { error: 'يرجى إدخال اسم المستخدم وكلمة المرور.' });

        const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');

        const envAdminUser = (process.env.ADMIN_USERNAME || 'admin').trim();
        const envAdminPass = (process.env.ADMIN_PASSWORD || 'admin').trim();

        if (username.toLowerCase() === envAdminUser.toLowerCase() && password === envAdminPass) {
            req.session.isLoggedIn = true;
            req.session.adminName = 'المدير الأساسي';
            req.session.adminRole = 'master';
            req.session.adminId = 'master_admin';
            return req.session.save(() => res.redirect('/'));
        }

        const admin = await Admin.findOne({ webUsername: usernameRegex }).lean();
        
        if (admin && admin.webPassword) {
            let isMatch = false;
            if (admin.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, admin.webPassword);
            } else {
                isMatch = (password === admin.webPassword);
                if (isMatch) {
                    const hashedPass = await bcrypt.hash(password, 12);
                    await Admin.updateOne({ _id: admin._id }, { webPassword: hashedPass });
                }
            }

            if (isMatch) {
                req.session.isLoggedIn = true;
                req.session.adminId = admin._id;
                req.session.adminName = admin.name;
                req.session.adminRole = admin.role || 'admin';
                return req.session.save(() => res.redirect('/'));
            }
        }
        return res.render('login', { error: 'بيانات الدخول غير صحيحة.' });
    } catch (error) {
        return res.render('login', { error: 'حدث خطأ داخلي في الخادم.' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// =======================================================
// 📊 لوحة الإدارة الرئيسية
// =======================================================
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

        const usersCount = await User.countDocuments();
        const companiesCount = await ClientBot.countDocuments();
        const executorsCount = await Employee.countDocuments();
        const pendingTxs = await Transaction.countDocuments({ status: 'pending' });
        const processingTxs = await Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } });
        const completedTxs = await Transaction.countDocuments({ status: 'completed', updatedAt: { $gte: startOfDay } });

        res.render('index', { 
            activePage: 'dashboard', adminName: req.session.adminName || 'مدير عام', role: req.session.adminRole || 'master',
            usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs
        });
    } catch (error) { res.status(500).send('Server Error'); }
});

// =======================================================
// 🖼️ مسار الجلب الوسيط (Proxy) لصور الإثبات في لوحة الإدارة 🚀
// =======================================================
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], isAuthenticated, async (req, res) => {
    try {
        // 🟢 استخدام .lean() لجلب الداتا كما هي وتخطي حماية Schema
        const tx = await Transaction.findById(req.params.id).lean();
        if (!tx) return res.status(404).send('لا توجد عملية');

        // 1️⃣ قراءة الصورة من الهارد ديسك (مسار Local Storage) الذي أنشأناه
        const possiblePaths = [tx.localProofImage, tx.proofImage];
        for (const p of possiblePaths) {
            if (p && p.startsWith('/uploads')) {
                const fullPath = path.join(process.cwd(), p);
                if (fs.existsSync(fullPath)) {
                    res.set('Cache-Control', 'public, max-age=31536000');
                    return res.sendFile(fullPath); // إرسال الملف الفعلي من السيرفر بسرعة البرق ⚡
                }
            }
        }

        // 2️⃣ قراءة الصورة المحقونة في قاعدة البيانات كـ Base64
        if (tx.proofImageBase64) {
            const b64 = tx.proofImageBase64.replace(/^data:image\/\w+;base64,/, "");
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(b64, 'base64'));
        }

        // --- (الأكواد القديمة للعمليات السابقة) ---
        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) photoId = tx.proofImages[index];
        else if (tx.proofImage && index === 0) photoId = tx.proofImage; 

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        if (photoId.startsWith('data:image')) {
            const base64Data = photoId.replace(/^data:image\/\w+;base64,/, "");
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(base64Data, 'base64'));
        }

        if (photoId.startsWith('http')) {
            const response = await axios.get(photoId, { responseType: 'arraybuffer' });
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(response.data));
        }

        // البحث في تيليجرام للعمليات القديمة جداً
        let tokensToTry = [];
        if (tx.executorBotId) { const execBot = await ExecutorBot.findById(tx.executorBotId); if (execBot && execBot.token) tokensToTry.push(execBot.token); }
        if (process.env.ADMIN_BOT_TOKEN) tokensToTry.push(process.env.ADMIN_BOT_TOKEN);
        if (process.env.CLIENT_BOT_TOKEN) tokensToTry.push(process.env.CLIENT_BOT_TOKEN);
        
        let fileLink = null;
        for (const token of [...new Set(tokensToTry)]) {
            try { const api = new Telegram(token); const link = await api.getFileLink(photoId); if (link && link.href) { fileLink = link.href; break; } } catch (e) {}
        }
        
        if (!fileLink) return res.status(404).send('الصورة غير متاحة لانتهاء صلاحية الرابط القديم');
        
        const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
        res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
        return res.send(Buffer.from(response.data));

    } catch (error) { 
        console.error('[Web Proxy Error]:', error.message);
        res.status(500).send('خطأ داخلي'); 
    }
});

module.exports = router;