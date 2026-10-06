'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TARGET_USERNAME = 'zaynapi@ahram.com';
const TARGET_ROLE = 'operator';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const assertPasswordStrength = (password) => {
    const value = String(password || '');
    if (
        value.length < 14
        || !/[a-z]/.test(value)
        || !/[A-Z]/.test(value)
        || !/[0-9]/.test(value)
        || /[\r\n]/.test(value)
    ) {
        const error = new Error('The new password must be a single line of at least 14 characters and include upper-case, lower-case, and numeric characters.');
        error.code = 'WEAK_PASSWORD';
        throw error;
    }
};

const generatePassword = () => {
    const bytes = crypto.randomBytes(32);
    let value = 'Aa1';
    for (let index = 0; index < 29; index += 1) {
        value += PASSWORD_ALPHABET[bytes[index] % PASSWORD_ALPHABET.length];
    }
    assertPasswordStrength(value);
    return value;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const writeRestrictedPasswordFile = (password, directory = path.join(process.cwd(), '.secrets'), options = {}) => {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const spawnSync = options.spawnSync || require('child_process').spawnSync;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(directory, 0o700);
    } catch (_error) {
        // Some platforms cannot chmod a directory. The file mode below still applies.
    }
    const filename = `leaked-seed-account-rotation-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const filePath = path.join(directory, filename);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    const descriptor = fs.openSync(filePath, flags, 0o600);
    try {
        // Restrict the empty file before it contains any credential.
        if (platform === 'win32') {
            const identity = env.USERNAME && (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME);
            if (!identity) throw new Error('Cannot secure password file: Windows account identity is unavailable.');
            const result = spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${identity}:(F)`], {
                stdio: 'ignore', windowsHide: true
            });
            if (result.error || result.status !== 0) {
                throw new Error('Cannot secure password file: Windows ACL restriction failed.');
            }
        } else {
            fs.fchmodSync(descriptor, 0o600);
        }
        fs.writeFileSync(descriptor, `${password}\n`, { encoding: 'utf8' });
    } catch (error) {
        fs.closeSync(descriptor);
        fs.rmSync(filePath, { force: true });
        throw error;
    }
    fs.closeSync(descriptor);
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (_error) {
        // Windows ACLs, enforced before writing, are authoritative on Windows.
    }
    return filePath;
};

const removePasswordFile = (filePath) => {
    if (!filePath) return;
    try {
        fs.rmSync(filePath, { force: true });
    } catch (_error) {
        if (process.platform === 'win32') {
            try {
                require('child_process').spawnSync('icacls', [filePath, '/reset'], {
                    stdio: 'ignore',
                    windowsHide: true
                });
                fs.rmSync(filePath, { force: true });
                return;
            } catch (_resetError) {
                // The caller reports rotation failure without the password.
            }
        }
    }
};

const applyCredentialRotation = async ({
    employee,
    passwordHash,
    models,
    logAction,
    session = null
}) => {
    if (!employee || !employee._id) {
        const error = new Error('Account does not exist. No changes were written.');
        error.code = 'ACCOUNT_NOT_FOUND';
        throw error;
    }
    if (!passwordHash || !String(passwordHash).startsWith('$2')) {
        const error = new Error('Refusing to store a password that is not a bcrypt hash.');
        error.code = 'HASH_REQUIRED';
        throw error;
    }

    const sessionOptions = session ? { session } : {};
    const updated = await models.Employee.updateOne(
        { _id: employee._id, webUsername: TARGET_USERNAME },
        {
            $set: { webPassword: passwordHash },
            $inc: { sessionVersion: 1 },
            $unset: {
                refreshToken: 1,
                otpCode: 1,
                otpExpires: 1,
                otpChallengeId: 1,
                otpIssuedAt: 1
            }
        },
        sessionOptions
    );
    if (!updated.matchedCount) {
        const error = new Error('Account does not exist. No changes were written.');
        error.code = 'ACCOUNT_NOT_FOUND';
        throw error;
    }

    const mobile = await models.MobileDeviceSession.updateMany(
        { accountId: employee._id, accountType: 'executor', active: true },
        {
            $set: {
                active: false,
                revokedAt: new Date(),
                revokeReason: 'password_reset'
            }
        },
        sessionOptions
    );

    let webSessionsDeleted = 0;
    if (models.sessions) {
        const id = String(employee._id);
        const web = await models.sessions.deleteMany({
            $or: [
                { session: new RegExp(escapeRegex(id)) },
                { 'session.executorId': id },
                { 'session.executorId': employee._id }
            ]
        }, sessionOptions);
        webSessionsDeleted = web.deletedCount || 0;
    }

    await logAction({
        action: 'CREDENTIAL_ROTATED',
        performedByModel: 'System',
        performedByName: 'leaked-seed-account-rotation',
        targetId: employee._id,
        targetModel: 'Employee',
        severity: 'critical',
        required: true,
        session,
        metadata: {
            reason: 'public_repository_leaked_seed_credential',
            webUsername: TARGET_USERNAME,
            role: employee.role || TARGET_ROLE,
            sessionVersionIncremented: true,
            mobileSessionsRevoked: mobile.modifiedCount || 0,
            webSessionsDeleted
        }
    });

    return {
        passwordUpdated: true,
        mobileSessionsRevoked: mobile.modifiedCount || 0,
        webSessionsDeleted
    };
};

const publicErrorMessage = (error, password) => {
    let message = String(error && error.message ? error.message : 'Rotation failed.');
    if (password && message.includes(password)) return 'Rotation failed.';
    message = message.replace(/(?:mongodb(?:\+srv)?|rediss?):\/\/\S+/gi, '[redacted]');
    return message;
};

const runRotation = async ({
    apply = false,
    findEmployee,
    hashPassword,
    applyChanges,
    resolvePassword,
    writePasswordFile = writeRestrictedPasswordFile,
    deletePasswordFile = removePasswordFile,
    persistPasswordFile = false,
    stdout = process.stdout,
    stderr = process.stderr
}) => {
    const writeOut = (line) => stdout.write(`${line}\n`);
    const employee = await findEmployee(TARGET_USERNAME);
    const exists = Boolean(employee);
    writeOut(`mode: ${apply ? 'apply' : 'dry-run'}`);
    writeOut(`account: ${TARGET_USERNAME}`);
    writeOut(`role: ${TARGET_ROLE}`);
    writeOut(`exists: ${exists ? 'yes' : 'no'}`);

    if (!apply) {
        writeOut('writes: none');
        return { exists, applied: false };
    }

    if (!exists) {
        stderr.write('Account does not exist. No changes were written.\n');
        const error = new Error('Account does not exist. No changes were written.');
        error.code = 'ACCOUNT_NOT_FOUND';
        throw error;
    }

    let password = '';
    let passwordFile = '';
    try {
        password = await resolvePassword();
        assertPasswordStrength(password);
        const passwordHash = await hashPassword(password);
        if (!passwordHash || passwordHash === password || String(passwordHash).includes(password)) {
            const error = new Error('Refusing to store a password that is not a bcrypt hash.');
            error.code = 'HASH_REQUIRED';
            throw error;
        }
        if (persistPasswordFile) {
            passwordFile = writePasswordFile(password);
        }
        const result = await applyChanges({ employee, passwordHash });
        writeOut('password: updated');
        writeOut(`mobileSessionsRevoked: ${result.mobileSessionsRevoked || 0}`);
        writeOut(`webSessionsDeleted: ${result.webSessionsDeleted || 0}`);
        writeOut('audit: appended');
        if (passwordFile) writeOut(`passwordFile: ${passwordFile}`);
        writeOut('The new password was not printed.');
        return { exists: true, applied: true, passwordFile, result };
    } catch (error) {
        if (passwordFile) deletePasswordFile(passwordFile);
        stderr.write(`${publicErrorMessage(error, password)}\n`);
        throw error;
    }
};

module.exports = {
    TARGET_ROLE,
    TARGET_USERNAME,
    applyCredentialRotation,
    assertPasswordStrength,
    generatePassword,
    removePasswordFile,
    runRotation,
    writeRestrictedPasswordFile
};
