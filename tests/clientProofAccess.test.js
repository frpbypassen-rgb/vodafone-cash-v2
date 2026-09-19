'use strict';

jest.mock('../models/Transaction');
jest.mock('../models/ClientEmployee');

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const ClientEmployee = require('../models/ClientEmployee');
const {
    assertCompanyOwnsProofTransaction,
    resolveClientProofImage
} = require('../services/clientProofAccessService');

const COMPANY_A = '64a000000000000000000001';
const COMPANY_B = '64a000000000000000000002';
const EMPLOYEE_A = '64c0000000000000000000aa';
const TX_A = '64b0000000000000000000aa';

const mockEmployeeQuery = (employee) => {
    ClientEmployee.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(employee)
        })
    });
};

describe('client proof access authorization', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('allows a company user to read a proof that belongs to the same companyId', async () => {
        const tx = {
            _id: TX_A,
            companyId: COMPANY_A,
            proofImage: 'proofs/company-a.jpg'
        };
        Transaction.findOne.mockResolvedValue(tx);
        mockEmployeeQuery({ _id: EMPLOYEE_A, companyId: COMPANY_A, status: 'active' });

        const result = await resolveClientProofImage({
            session: { accountType: 'company', clientId: EMPLOYEE_A },
            transactionId: TX_A,
            index: 0,
            ownershipFilter: { companyId: COMPANY_A }
        });

        expect(Transaction.findOne).toHaveBeenCalledWith({ $and: [{ _id: TX_A }, { companyId: COMPANY_A }] });
        expect(result.photoId).toBe('proofs/company-a.jpg');
        expect(result.index).toBe(0);
    });

    test('rejects a company user when the transaction belongs to another company', async () => {
        Transaction.findOne.mockResolvedValue({
            _id: TX_A,
            companyId: COMPANY_B,
            proofImage: 'proofs/company-b.jpg'
        });
        mockEmployeeQuery({ _id: EMPLOYEE_A, companyId: COMPANY_A, status: 'active' });

        await expect(resolveClientProofImage({
            session: { accountType: 'company', clientId: EMPLOYEE_A },
            transactionId: TX_A,
            index: 0,
            ownershipFilter: { companyId: COMPANY_A }
        })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });

    test('rejects a company user when the transaction has no companyId', async () => {
        Transaction.findOne.mockResolvedValue({
            _id: TX_A,
            proofImage: 'proofs/orphan.jpg'
        });
        mockEmployeeQuery({ _id: EMPLOYEE_A, companyId: COMPANY_A, status: 'active' });

        await expect(resolveClientProofImage({
            session: { accountType: 'company', clientId: EMPLOYEE_A },
            transactionId: TX_A,
            ownershipFilter: { companyId: COMPANY_A }
        })).rejects.toMatchObject({ statusCode: 403 });
    });

    test('rejects when no ownership filter is provided', async () => {
        await expect(resolveClientProofImage({
            session: { accountType: 'company', clientId: EMPLOYEE_A },
            transactionId: TX_A,
            ownershipFilter: null
        })).rejects.toMatchObject({ statusCode: 403 });
        expect(Transaction.findOne).not.toHaveBeenCalled();
    });

    test('rejects an invalid transaction id before querying', async () => {
        await expect(resolveClientProofImage({
            session: { accountType: 'company', clientId: EMPLOYEE_A },
            transactionId: 'not-an-id',
            ownershipFilter: { companyId: COMPANY_A }
        })).rejects.toMatchObject({ statusCode: 404 });
        expect(Transaction.findOne).not.toHaveBeenCalled();
    });

    test('returns 404 when the official proof is missing', async () => {
        Transaction.findOne.mockResolvedValue({
            _id: TX_A,
            companyId: COMPANY_A,
            executorProofImages: ['proofs/executor-only.jpg']
        });
        mockEmployeeQuery({ _id: EMPLOYEE_A, companyId: COMPANY_A, status: 'active' });

        await expect(resolveClientProofImage({
            session: { accountType: 'company', clientId: EMPLOYEE_A },
            transactionId: TX_A,
            index: 0,
            ownershipFilter: { companyId: COMPANY_A }
        })).rejects.toMatchObject({ statusCode: 404 });
    });

    test('does not apply the companyId extra check to non-company client sessions', async () => {
        Transaction.findOne.mockResolvedValue({
            _id: TX_A,
            userId: '0910000000',
            proofImage: 'proofs/direct.jpg'
        });

        const result = await resolveClientProofImage({
            session: { accountType: 'user', clientId: '64d000000000000000000001' },
            transactionId: TX_A,
            ownershipFilter: { userId: '0910000000' }
        });

        expect(ClientEmployee.findById).not.toHaveBeenCalled();
        expect(result.photoId).toBe('proofs/direct.jpg');
    });

    test('assertCompanyOwnsProofTransaction compares companyId strictly', () => {
        expect(() => assertCompanyOwnsProofTransaction(
            { companyId: COMPANY_A, status: 'active' },
            { companyId: COMPANY_A }
        )).not.toThrow();

        expect(() => assertCompanyOwnsProofTransaction(
            { companyId: COMPANY_A, status: 'active' },
            { companyId: COMPANY_B }
        )).toThrow(/غير مصرح/);

        expect(() => assertCompanyOwnsProofTransaction(
            { companyId: COMPANY_A, status: 'banned' },
            { companyId: COMPANY_A }
        )).toThrow(/غير مصرح/);
    });

    test('uses a real ObjectId for the happy path', () => {
        expect(mongoose.isValidObjectId(TX_A)).toBe(true);
        expect(mongoose.isValidObjectId(COMPANY_A)).toBe(true);
    });
});
