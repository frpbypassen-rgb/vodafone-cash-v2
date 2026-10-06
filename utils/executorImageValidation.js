'use strict';

const { imageSize } = require('image-size');

const DEFAULT_MAX_PIXELS = 40 * 1000 * 1000;
const DEFAULT_MAX_DIMENSION = 12000;
const MIME_TYPES = Object.freeze({
    jpeg: 'jpg',
    jpg: 'jpg',
    png: 'png',
    webp: 'webp'
});

const decodedSizeUpperBound = (encodedLength) => Math.ceil(encodedLength / 4) * 3;

const parseExecutorImageDataUrl = (value, options = {}) => {
    const {
        maxBytes,
        maxPixels = DEFAULT_MAX_PIXELS,
        maxDimension = DEFAULT_MAX_DIMENSION,
        allowWrappedBase64 = false,
        errorCode = 'INVALID_IMAGE'
    } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || typeof value !== 'string') {
        throw new Error(errorCode);
    }
    const match = value.match(/^data:image\/(jpeg|jpg|png|webp);base64,/i);
    if (!match) throw new Error(errorCode);
    const rawEncoded = value.slice(match[0].length);
    const encoded = allowWrappedBase64 ? rawEncoded.replace(/[\r\n]/g, '') : rawEncoded;
    if (!encoded || (!allowWrappedBase64 && encoded !== rawEncoded)
        || /[^A-Za-z0-9+/=]/.test(encoded)
        || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4
        || decodedSizeUpperBound(encoded.length) > maxBytes + 2) {
        throw new Error(errorCode);
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > maxBytes) throw new Error(errorCode);

    let metadata;
    try {
        metadata = imageSize(buffer);
    } catch (_error) {
        throw new Error(errorCode);
    }
    const extension = MIME_TYPES[match[1].toLowerCase()];
    const detectedExtension = MIME_TYPES[String(metadata.type || '').toLowerCase()];
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (detectedExtension !== extension || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0 || width > maxDimension || height > maxDimension
        || width * height > maxPixels) {
        throw new Error(errorCode);
    }
    return { buffer, extension, width, height };
};

module.exports = {
    DEFAULT_MAX_DIMENSION,
    DEFAULT_MAX_PIXELS,
    parseExecutorImageDataUrl
};
