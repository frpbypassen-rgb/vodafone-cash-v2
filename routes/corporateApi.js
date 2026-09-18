'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const {
    requireCorporateAuth,
    requireCorporateRole,
    requireSameCompany,
    allowCorporateCamera
} = require('../middlewares/corporateAuth');
const controller = require('../controllers/corporatePortalController');

const invoiceUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, controller.ensureUploadDir()),
        filename: (_req, file, callback) => {
            const extension = path.extname(file.originalname || '').slice(0, 8) || '.bin';
            callback(null, `invoice-${crypto.randomUUID()}${extension}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        const allowed = new Set([
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp',
            'application/pdf'
        ]);
        if (!allowed.has(file.mimetype)) return callback(new Error('INVALID_DOCUMENT_TYPE'));
        return callback(null, true);
    }
});

router.use(allowCorporateCamera);
router.use(requireCorporateAuth, requireSameCompany);

router.get('/me', controller.getMe);
router.get('/dashboard', controller.getDashboard);

router.get('/beneficiaries', controller.listBeneficiaries);
router.post('/beneficiaries', requireCorporateRole(['manager']), controller.createBeneficiary);
router.patch('/beneficiaries/:id', requireCorporateRole(['manager']), controller.updateBeneficiary);

router.get('/requests', controller.listRequests);
router.post('/requests', requireCorporateRole(['manager', 'employee']), controller.createPaymentRequest);
router.post('/requests/:id/approve', requireCorporateRole(['manager']), controller.approveRequest);
router.post('/requests/:id/reject', requireCorporateRole(['manager']), controller.rejectRequest);
router.post('/requests/:id/notes', requireCorporateRole(['manager', 'accountant']), controller.addRequestNote);
router.post('/requests/:id/reconcile', requireCorporateRole(['accountant']), controller.reconcileRequest);

router.get('/staff', requireCorporateRole(['manager', 'accountant']), controller.listStaff);
router.post('/staff/:id/permissions', requireCorporateRole(['manager']), controller.assignStaff);

router.get('/reports/export', controller.exportReport);
router.get('/audit', requireCorporateRole(['manager', 'accountant']), controller.listAudit);

router.get('/insights', controller.getInsights);
router.get('/insights/suggest', requireCorporateRole(['employee', 'manager']), controller.getInsights);
router.post('/insights/ocr', controller.parseOcr);
router.post('/insights/match-invoice', requireCorporateRole(['accountant']), controller.matchInvoice);
router.post('/invoices', requireCorporateRole(['accountant']), invoiceUpload.single('file'), controller.uploadInvoice);

router.post('/confirm/password', controller.confirmPassword);
router.get('/confirm/webauthn/options', controller.webauthnOptions);
router.post('/confirm/webauthn/verify', controller.webauthnVerify);

router.use((error, req, res, next) => {
    if (error && error.message === 'INVALID_DOCUMENT_TYPE') {
        return res.status(400).json({ success: false, code: 'INVALID_DOCUMENT_TYPE', error: 'نوع الملف غير مسموح.' });
    }
    return next(error);
});

module.exports = router;
