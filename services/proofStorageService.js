'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parseProofImage } = require('./executorProofStorageService');
const { inlineExecutorProof } = require('../utils/executorProofIds');
const { randomUUID } = require('node:crypto');

const PROOF_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'proofs');

const localProofId = (photoId) => {
    const cleaned = String(photoId || '').replace(/^\/?uploads\//, '').replace(/\\/g, '/').replace(/^proofs\//, '');
    const safeName = path.basename(cleaned);
    if (!safeName) return null;
    return `proofs/${safeName}`;
};

const proofFilePath = (photoId) => {
    const localId = localProofId(photoId);
    if (!localId) return null;
    const safeName = path.basename(localId);
    return path.join(PROOF_UPLOAD_DIR, safeName);
};

const saveProofImage = (imageBase64, txId) => {
    const payload = String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(payload, 'base64');
    if (!buffer.length) {
        const error = new Error('MALFORMED_IMAGE');
        error.statusCode = 400;
        error.code = 'MALFORMED_IMAGE';
        throw error;
    }

    fs.mkdirSync(PROOF_UPLOAD_DIR, { recursive: true });
    const safeTxId = String(txId || 'proof').replace(/[^\w.-]/g, '_');
    const fileName = `${safeTxId}_${Date.now()}.jpg`;
    const fullPath = proofFilePath(fileName);
    fs.writeFileSync(fullPath, buffer);
    return `proofs/${fileName}`;
};

const proofSourceUrl = (photoId) => {
    const value = String(photoId || '');
    if (/^https?:\/\//i.test(value)) return value;

    const localId = localProofId(value);
    const localPath = proofFilePath(value);
    if (localId && (value.replace(/^\/?uploads\//, '').startsWith('proofs/') || (localPath && fs.existsSync(localPath)))) {
        return `/uploads/${localId}`;
    }

    const token = process.env.ADMIN_BOT_TOKEN;
    return token
        ? `https://api.telegram.org/file/bot${token}/${encodeURIComponent(value)}`
        : `/uploads/${value}`;
};

const streamProofImage = async (sourceUrl, res) => {
    const fileUrl = String(sourceUrl || '');
    if (!/^https?:\/\//i.test(fileUrl)) {
        const localPath = proofFilePath(fileUrl);
        if (!localPath || !fs.existsSync(localPath)) {
            const error = new Error('PROOF_NOT_FOUND');
            error.statusCode = 404;
            error.code = 'NOT_FOUND';
            throw error;
        }
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.sendFile(localPath);
        return;
    }

    const upstream = await axios.get(fileUrl, {
        responseType: 'stream',
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 300
    });

    const contentType = upstream.headers['content-type'] || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
        const error = new Error('INVALID_PROOF_CONTENT_TYPE');
        error.statusCode = 502;
        error.code = 'SERVER_ERROR';
        throw error;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    upstream.data.pipe(res);
};

const streamExecutorProof = async (proofId, res) => {
    if (!inlineExecutorProof(proofId)) {
        return streamProofImage(proofSourceUrl(proofId), res);
    }
    let image;
    try {
        image = parseProofImage(proofId, { allowMimeMismatch: true });
    } catch (_) {
        throw Object.assign(new Error('PROOF_NOT_FOUND'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(image.extension).send(image.buffer);
};

const persistExecutorPartProofs = (entries, txId) => {
    // Mobile builds can label gallery PNG/WebP bytes as JPEG.
    const parsed = entries.map(entry => entry.proofImage
        ? parseProofImage(entry.proofImage, { allowMimeMismatch: true })
        : null);
    if (parsed.some(Boolean)) fs.mkdirSync(PROOF_UPLOAD_DIR, { recursive: true });
    const safeId = String(txId).replace(/[^\w.-]/g, '_');
    return entries.map((entry, index) => {
        const image = parsed[index];
        if (!image) return entry;
        const name = `${safeId}_sender_${index + 1}_${randomUUID()}.${image.extension}`;
        fs.writeFileSync(path.join(PROOF_UPLOAD_DIR, name), image.buffer);
        return { ...entry, proofImage: `proofs/${name}` };
    });
};

module.exports = {
    proofFilePath,
    proofSourceUrl,
    saveProofImage,
    streamProofImage,
    streamExecutorProof,
    persistExecutorPartProofs
};
