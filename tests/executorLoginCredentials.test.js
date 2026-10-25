'use strict';

jest.mock('../models/Employee', () => ({ findOne: jest.fn() }));
jest.mock('../utils/helpers', () => ({
    ...jest.requireActual('../utils/helpers'),
    verifyAndUpgradePassword: jest.fn().mockResolvedValue(false)
}));

const Employee = require('../models/Employee');
const { verifyAndUpgradePassword } = require('../utils/helpers');
const { postLogin } = require('../controllers/executorAuthController');

beforeEach(() => {
    jest.clearAllMocks();
    Employee.findOne.mockReturnValue({
        populate: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ _id: 'executor-test', webPassword: 'stored-hash' })
        })
    });
});

test.each([' password with spaces ', 'ordinary-password', '  كلمة مرور  '])(
    'verifies the exact password supplied without stripping characters: %p', async password => {
        const req = { body: { username: ' operator ', password }, session: {} };
        const res = { render: jest.fn() };
        await postLogin(req, res);
        expect(Employee.findOne).toHaveBeenCalledWith({
            $or: [{ webUsername: /^operator$/i }, { phone: 'operator' }]
        });
        expect(verifyAndUpgradePassword).toHaveBeenCalledWith(password, 'stored-hash', Employee, 'executor-test');
        expect(res.render).toHaveBeenCalledWith('executor/login', expect.objectContaining({ error: expect.any(String) }));
    }
);

test.each([undefined, {}, 1234])('rejects non-string passwords without querying credentials: %p', async password => {
    const req = { body: { username: 'operator', password }, session: {} };
    const res = { render: jest.fn() };
    await postLogin(req, res);
    expect(Employee.findOne).not.toHaveBeenCalled();
    expect(verifyAndUpgradePassword).not.toHaveBeenCalled();
    expect(res.render).toHaveBeenCalledWith('executor/login', expect.objectContaining({ error: expect.any(String) }));
});
