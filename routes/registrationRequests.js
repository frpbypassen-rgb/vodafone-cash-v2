// routes/registrationRequests.js
// =====================================================
// 📋 إدارة طلبات التسجيل — Registration Requests Management
// =====================================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const RegistrationRequest = require('../models/RegistrationRequest');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const { requireAuth, requireMaster } = require('../middlewares/auth');

// ─────────────────────────────────────────────────
// 📋 عرض جميع طلبات التسجيل
// ─────────────────────────────────────────────────
router.get('/registration-requests', requireAuth, async (req, res) => {
    try {
        const statusFilter = req.query.status;
        const filter = statusFilter ? { status: statusFilter } : {};
        
        const requests = await RegistrationRequest.find(filter).sort({ createdAt: -1 }).lean();
        
        // إحصائيات سريعة
        const counts = {
            pending: await RegistrationRequest.countDocuments({ status: 'pending' }),
            approved: await RegistrationRequest.countDocuments({ status: 'approved' }),
            rejected: await RegistrationRequest.countDocuments({ status: 'rejected' }),
            total: await RegistrationRequest.countDocuments({})
        };

        res.render('registration_requests', { 
            requests, 
            counts, 
            status: statusFilter || '',
            activePage: 'registration_requests',
            query: req.query 
        });
    } catch (error) {
        console.error('[RegistrationRequests] Error:', error.message);
        res.status(500).send('حدث خطأ في تحميل طلبات التسجيل');
    }
});

// ─────────────────────────────────────────────────
// ✅ قبول طلب تسجيل وإنشاء الحساب
// ─────────────────────────────────────────────────
router.post('/registration-requests/:id/approve', requireAuth, requireMaster, async (req, res) => {
    try {
        const regReq = await RegistrationRequest.findById(req.params.id);
        if (!regReq || regReq.status !== 'pending') {
            return res.redirect('/registration-requests?error=not_found');
        }

        const adminName = req.session.adminName || 'مدير';

        // ─── إنشاء الحساب حسب نوع الطلب ───
        if (regReq.accountType === 'direct') {
            // عميل مباشر → إنشاء حساب User
            await User.create({
                name: regReq.fullName,
                phone: regReq.phone,
                webUsername: regReq.username,
                webPassword: regReq.password, // مشفر مسبقاً في RegistrationRequest
                storeName: regReq.storeName,
                address: regReq.address,
                tier: 1,
                balance: 0,
                status: 'active',
                role: 'user'
            });

        } else if (regReq.accountType === 'new') {
            // عميل جديد (بدون متجر) → إنشاء حساب User
            const phoneUsername = String(regReq.phone || regReq._id).replace(/\D/g, '') || String(regReq._id);
            await User.create({
                name: regReq.fullName,
                phone: regReq.phone,
                webUsername: regReq.username || `${phoneUsername}@ahram.local`,
                nationality: regReq.nationality,
                city: regReq.city,
                webPassword: regReq.password,
                tier: 1,
                balance: 0,
                status: 'active',
                role: 'user'
            });

        } else if (regReq.accountType === 'company') {
            // شركة → إنشاء ClientCompany + ClientEmployee (مدير الشركة)
            const company = await ClientCompany.create({
                name: regReq.companyName,
                phone: regReq.companyPhone,
                tier: 3,
                balance: 0,
                status: 'active'
            });

            await ClientEmployee.create({
                name: regReq.companyContact || regReq.companyName,
                phone: regReq.companyPhone,
                companyId: company._id,
                webUsername: regReq.username,
                webPassword: regReq.password,
                canViewAllReports: true,
                status: 'active'
            });

        } else if (regReq.accountType === 'agent') {
            // وكيل منطقة → إنشاء حساب User بصلاحيات وكيل
            await User.create({
                name: regReq.fullName,
                phone: regReq.phone,
                webUsername: regReq.username,
                webPassword: regReq.password,
                storeName: regReq.companyName,
                address: regReq.address,
                agentCode: regReq.agentCode,
                tier: 2,
                balance: 0,
                status: 'active',
                role: 'agent'
            });

        } else if (regReq.accountType === 'executor') {
            // منفذ → إنشاء ExecutorGroup + Employee (مدير)
            const newGroup = await ExecutorGroup.create({
                name: regReq.companyName,
                isManagerBot: true,
                isApiBot: false,
                status: 'active'
            });

            await Employee.create({
                name: regReq.fullName,
                phone: regReq.phone,
                role: 'manager',
                status: 'active',
                groupId: newGroup._id,
                webUsername: regReq.username,
                webPassword: regReq.password
            });
        }

        // تحديث حالة الطلب
        regReq.status = 'approved';
        regReq.reviewedBy = adminName;
        regReq.reviewedAt = new Date();
        await regReq.save();

        // تسجيل في Audit Log
        try {
            const { logAction } = require('../services/auditService');
            await logAction({
                action: 'REGISTRATION_APPROVED',
                performedBy: adminName,
                metadata: { 
                    requestId: regReq._id, 
                    refCode: regReq.refCode, 
                    accountType: regReq.accountType,
                    name: regReq.fullName || regReq.companyName
                }
            });
        } catch (e) { /* ignore audit errors */ }

        res.redirect('/registration-requests?success=approved');

    } catch (error) {
        console.error('[RegistrationRequests] Approve Error:', error.message);
        res.redirect('/registration-requests?error=approve_failed');
    }
});

// ─────────────────────────────────────────────────
// ❌ رفض طلب تسجيل
// ─────────────────────────────────────────────────
router.post('/registration-requests/:id/reject', requireAuth, requireMaster, async (req, res) => {
    try {
        const regReq = await RegistrationRequest.findById(req.params.id);
        if (!regReq || regReq.status !== 'pending') {
            return res.redirect('/registration-requests?error=not_found');
        }

        const adminName = req.session.adminName || 'مدير';

        regReq.status = 'rejected';
        regReq.reviewedBy = adminName;
        regReq.reviewedAt = new Date();
        regReq.adminNotes = req.body.notes || 'تم الرفض من الإدارة';
        await regReq.save();

        // تسجيل في Audit Log
        try {
            const { logAction } = require('../services/auditService');
            await logAction({
                action: 'REGISTRATION_REJECTED',
                performedBy: adminName,
                metadata: { 
                    requestId: regReq._id, 
                    refCode: regReq.refCode,
                    accountType: regReq.accountType
                }
            });
        } catch (e) { /* ignore audit errors */ }

        res.redirect('/registration-requests?success=rejected');

    } catch (error) {
        console.error('[RegistrationRequests] Reject Error:', error.message);
        res.redirect('/registration-requests?error=reject_failed');
    }
});

module.exports = router;
