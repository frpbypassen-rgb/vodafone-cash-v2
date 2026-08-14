'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'profiles');
const IMAGE_PATTERN = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i;

const profileFilePath = (photoKey) => {
    const fileName = path.basename(String(photoKey || '').replace(/^profiles\//, ''));
    return fileName ? path.join(PROFILE_UPLOAD_DIR, fileName) : null;
};

const extensionFor = (mime) => ({
    jpeg: 'jpg',
    jpg: 'jpg',
    png: 'png',
    webp: 'webp'
}[String(mime || '').toLowerCase()] || 'jpg');

const saveProfilePhoto = (imageBase64, accountId) => {
    const match = String(imageBase64 || '').match(IMAGE_PATTERN);
    if (!match) {
        const error = new Error('MALFORMED_IMAGE');
        error.code = 'MALFORMED_IMAGE';
        throw error;
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
        const error = new Error('MALFORMED_IMAGE');
        error.code = buffer.length > 2 * 1024 * 1024 ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_IMAGE';
        throw error;
    }

    fs.mkdirSync(PROFILE_UPLOAD_DIR, { recursive: true });
    const safeAccountId = String(accountId || 'account').replace(/[^\w.-]/g, '_');
    const photoKey = `profiles/${safeAccountId}_${Date.now()}.${extensionFor(match[1])}`;
    fs.writeFileSync(profileFilePath(photoKey), buffer);
    return photoKey;
};

const streamProfilePhoto = (photoKey, res) => {
    const fullPath = profileFilePath(photoKey);
    if (!fullPath || !fs.existsSync(fullPath)) {
        const error = new Error('PROFILE_PHOTO_NOT_FOUND');
        error.code = 'NOT_FOUND';
        throw error;
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(fullPath);
};

const removeProfilePhoto = (photoKey) => {
    const fullPath = profileFilePath(photoKey);
    if (fullPath && fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
};

module.exports = {
    saveProfilePhoto,
    streamProfilePhoto,
    removeProfilePhoto
};
