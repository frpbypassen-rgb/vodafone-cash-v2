'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { hashPassword } = require('../services/passwordService');
const {
    TARGET_USERNAME,
    applyCredentialRotation,
    runRotation,
    writeRestrictedPasswordFile
} = require('../scripts/lib/rotateLeakedSeedAccount');

const capture = () => {
    let text = '';
    return {
        stream: {
            write(chunk) {
                text += chunk;
                return true;
            }
        },
        text: () => text
    };
};

const PASSWORD = 'Rotate-Test-Password-91';

const employee = () => ({
    _id: '507f1f77bcf86cd799439011',
    webUsername: TARGET_USERNAME,
    role: 'operator',
    status: 'active',
    sessionVersion: 4
});

describe('leaked seed account rotation', () => {
    test.each([{ status: 1 }, { status: null, error: new Error('missing icacls') }])(
        'ACL failure leaves no password file and prevents credential mutation', async (aclResult) => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-acl-'));
            const applyChanges = jest.fn();
            const runAcl = jest.fn(() => {
                const [filePath] = runAcl.mock.calls[0][1];
                expect(fs.readFileSync(filePath, 'utf8')).toBe('');
                return aclResult;
            });
            try {
                await expect(runRotation({
                    apply: true,
                    findEmployee: async () => employee(),
                    hashPassword: async () => '$2b$12$alreadyhashedvalue',
                    applyChanges,
                    resolvePassword: async () => PASSWORD,
                    persistPasswordFile: true,
                    writePasswordFile: (value) => writeRestrictedPasswordFile(value, directory, {
                        platform: 'win32', env: { USERNAME: 'test', USERDOMAIN: 'machine' }, spawnSync: runAcl
                    }),
                    stdout: capture().stream, stderr: capture().stream
                })).rejects.toThrow('ACL restriction failed');
                expect(applyChanges).not.toHaveBeenCalled();
                expect(fs.readdirSync(directory)).toEqual([]);
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }
    );

    test('Windows identity is required before writing the credential', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-identity-'));
        const runAcl = jest.fn();
        try {
            expect(() => writeRestrictedPasswordFile(PASSWORD, directory, {
                platform: 'win32', env: {}, spawnSync: runAcl
            })).toThrow('identity is unavailable');
            expect(runAcl).not.toHaveBeenCalled();
            expect(fs.readdirSync(directory)).toEqual([]);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('dry-run reports existence and makes no writes', async () => {
        const stdout = capture();
        const stderr = capture();
        const hash = jest.fn();
        const applyChanges = jest.fn();
        const resolvePassword = jest.fn();
        const writePasswordFile = jest.fn();

        const result = await runRotation({
            apply: false,
            findEmployee: async () => employee(),
            hashPassword: hash,
            applyChanges,
            resolvePassword,
            writePasswordFile,
            stdout: stdout.stream,
            stderr: stderr.stream
        });

        expect(result).toEqual({ exists: true, applied: false });
        expect(hash).not.toHaveBeenCalled();
        expect(applyChanges).not.toHaveBeenCalled();
        expect(resolvePassword).not.toHaveBeenCalled();
        expect(writePasswordFile).not.toHaveBeenCalled();
        expect(stdout.text()).toContain('mode: dry-run');
        expect(stdout.text()).toContain('exists: yes');
        expect(stdout.text()).toContain('writes: none');
        expect(`${stdout.text()}${stderr.text()}`).not.toContain(PASSWORD);
    });

    test('dry-run of a missing account still makes no writes', async () => {
        const stdout = capture();
        const applyChanges = jest.fn();
        const result = await runRotation({
            apply: false,
            findEmployee: async () => null,
            hashPassword: jest.fn(),
            applyChanges,
            resolvePassword: jest.fn(),
            stdout: stdout.stream,
            stderr: capture().stream
        });
        expect(result).toEqual({ exists: false, applied: false });
        expect(applyChanges).not.toHaveBeenCalled();
        expect(stdout.text()).toContain('exists: no');
        expect(stdout.text()).toContain('writes: none');
    });

    test('--apply hashes, invalidates sessions, writes audit, and never logs the password', async () => {
        const passwordHash = await hashPassword(PASSWORD);
        expect(passwordHash.startsWith('$2')).toBe(true);
        expect(await bcrypt.compare(PASSWORD, passwordHash)).toBe(true);
        expect(passwordHash).not.toContain(PASSWORD);

        const Employee = {
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
        };
        const MobileDeviceSession = {
            updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 })
        };
        const sessions = {
            deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 })
        };
        const logAction = jest.fn().mockResolvedValue();
        const account = employee();

        const applied = await applyCredentialRotation({
            employee: account,
            passwordHash,
            models: { Employee, MobileDeviceSession, sessions },
            logAction,
            session: { id: 'db-session' }
        });

        expect(applied).toEqual({
            passwordUpdated: true,
            mobileSessionsRevoked: 2,
            webSessionsDeleted: 1
        });
        const [filter, update, options] = Employee.updateOne.mock.calls[0];
        expect(filter).toEqual({ _id: account._id, webUsername: TARGET_USERNAME });
        expect(update.$set).toEqual({ webPassword: passwordHash });
        expect(update.$set.balance).toBeUndefined();
        expect(update.$inc).toEqual({ sessionVersion: 1 });
        expect(update.$unset).toEqual(expect.objectContaining({ refreshToken: 1 }));
        expect(options).toEqual({ session: { id: 'db-session' } });
        expect(JSON.stringify(update)).not.toContain(PASSWORD);

        expect(MobileDeviceSession.updateMany).toHaveBeenCalledWith(
            { accountId: account._id, accountType: 'executor', active: true },
            expect.objectContaining({
                $set: expect.objectContaining({ active: false, revokeReason: 'password_reset' })
            }),
            { session: { id: 'db-session' } }
        );
        expect(sessions.deleteMany).toHaveBeenCalledWith(
            expect.objectContaining({ $or: expect.any(Array) }),
            { session: { id: 'db-session' } }
        );
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'CREDENTIAL_ROTATED',
            targetModel: 'Employee',
            required: true,
            severity: 'critical'
        }));
        const auditPayload = JSON.stringify(logAction.mock.calls[0][0]);
        expect(auditPayload).not.toContain(PASSWORD);
        expect(auditPayload).not.toContain(passwordHash);
        expect(auditPayload).not.toContain('webPassword');

        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-rotation-'));
        const stdout = capture();
        const stderr = capture();
        try {
            const result = await runRotation({
                apply: true,
                findEmployee: async () => account,
                hashPassword: async (value) => {
                    expect(value).toBe(PASSWORD);
                    return passwordHash;
                },
                applyChanges: async ({ passwordHash: storedHash }) => {
                    expect(storedHash).toBe(passwordHash);
                    return applied;
                },
                resolvePassword: async () => PASSWORD,
                persistPasswordFile: true,
                writePasswordFile: (value) => writeRestrictedPasswordFile(value, directory),
                stdout: stdout.stream,
                stderr: stderr.stream
            });
            const combined = `${stdout.text()}${stderr.text()}`;
            expect(combined).not.toContain(PASSWORD);
            expect(combined).not.toContain(passwordHash);
            expect(stdout.text()).toContain('mode: apply');
            expect(stdout.text()).toContain('audit: appended');
            expect(stdout.text()).toContain(`passwordFile: ${result.passwordFile}`);
            expect(fs.readFileSync(result.passwordFile, 'utf8')).toBe(`${PASSWORD}\n`);
            if (process.platform === 'win32') {
                const { spawnSync } = require('child_process');
                const acl = spawnSync('icacls', [result.passwordFile], { encoding: 'utf8', windowsHide: true });
                expect(acl.status).toBe(0);
                expect(acl.stdout).not.toContain('(I)');
                expect(acl.stdout).toContain(`${process.env.USERNAME}:(F)`);
            } else {
                expect(fs.statSync(result.passwordFile).mode & 0o777).toBe(0o600);
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('a failed --apply removes the password file and still does not log the password', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-rotation-fail-'));
        const stdout = capture();
        const stderr = capture();
        try {
            await expect(runRotation({
                apply: true,
                findEmployee: async () => employee(),
                hashPassword: async () => '$2b$12$alreadyhashedvalue',
                applyChanges: async () => {
                    throw new Error('database write failed');
                },
                resolvePassword: async () => PASSWORD,
                persistPasswordFile: true,
                writePasswordFile: (value) => writeRestrictedPasswordFile(value, directory),
                stdout: stdout.stream,
                stderr: stderr.stream
            })).rejects.toThrow('database write failed');
            expect(fs.readdirSync(directory)).toEqual([]);
            expect(`${stdout.text()}${stderr.text()}`).not.toContain(PASSWORD);
            expect(stderr.text()).toContain('database write failed');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('refuses to store a plaintext password and does not write sessions or audit', async () => {
        const Employee = { updateOne: jest.fn() };
        const MobileDeviceSession = { updateMany: jest.fn() };
        const logAction = jest.fn();
        await expect(applyCredentialRotation({
            employee: employee(),
            passwordHash: PASSWORD,
            models: { Employee, MobileDeviceSession, sessions: { deleteMany: jest.fn() } },
            logAction
        })).rejects.toThrow(/bcrypt/);
        expect(Employee.updateOne).not.toHaveBeenCalled();
        expect(MobileDeviceSession.updateMany).not.toHaveBeenCalled();
        expect(logAction).not.toHaveBeenCalled();
    });

    test('the rotation command does not restart PM2', () => {
        const source = fs.readFileSync(path.join(__dirname, '../scripts/rotateLeakedSeedAccount.js'), 'utf8');
        expect(source).not.toMatch(/pm2\s+(?:restart|reload|delete)/i);
        expect(source).toContain("includes('--apply')");
    });
});
