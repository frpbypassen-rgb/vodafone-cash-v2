'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-longer-than-thirty-two-characters';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-that-is-longer-than-thirty-two-characters';

const request = require('supertest');
const express = require('express');

const account = {
    _id: '507f1f77bcf86cd799439011',
    name: 'محمد علي إبراهيم',
    phone: '0940719000',
    webUsername: 'mohamed@ahram.com',
    businessProfile: { address: 'طرابلس' },
    status: 'active',
    createdAt: new Date('2026-08-14T00:00:00.000Z')
};

const updatedAccount = {
    ...account,
    name: 'محمد أحمد إبراهيم',
    businessProfile: { address: 'بنغازي' }
};

jest.mock('../middlewares/jwtAuth', () => ({
    authenticateJWT: (req, _res, next) => {
        req.user = { userId: account._id, accountType: 'client_user', sessionId: 'current-session' };
        next();
    }
}));
jest.mock('../models/User', () => ({
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn()
}));
jest.mock('../models/SubAccount', () => ({}));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/MobileDeviceSession', () => ({
    find: jest.fn(),
    updateMany: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue() }));
jest.mock('../services/profilePhotoStorageService', () => ({
    saveProfilePhoto: jest.fn(),
    streamProfilePhoto: jest.fn(),
    removeProfilePhoto: jest.fn()
}));

const User = require('../models/User');
const mobileRouter = require('../routes/mobileApi');

describe('mobile customer profile routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        User.findOne.mockResolvedValue(account);
        User.findByIdAndUpdate.mockResolvedValue(updatedAccount);
    });

    test('updates name and address while preserving phone and username', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/mobile', mobileRouter);

        const response = await request(app)
            .patch('/api/mobile/client/profile')
            .send({ name: 'محمد أحمد إبراهيم', address: 'بنغازي' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            profile: {
                name: 'محمد أحمد إبراهيم',
                phone: '0940719000',
                username: 'mohamed@ahram.com',
                address: 'بنغازي',
                status: 'active'
            }
        });
        expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
            account._id,
            { $set: { name: 'محمد أحمد إبراهيم', 'businessProfile.address': 'بنغازي' } },
            { new: true, runValidators: true }
        );
    });
});
