'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const { createCanvas, loadImage } = require('canvas');

const { createDepositReceiptProof } = require('../services/depositReceiptService');
const { createBalanceTransferReceiptProof } = require('../services/balanceTransferReceiptService');
const { createCancellationReceiptProof } = require('../services/cancellationReceiptService');
const { generateReceiptBase64 } = require('../utils/receiptGenerator');
const { generateCustomReceipt } = require('../services/externalApiService');
const { proofFilePath } = require('../services/proofStorageService');

const outDir = path.join(process.cwd(), 'docs', 'receipt-previews');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const proofPath = (proofId) => proofFilePath(proofId);

const svgSize = (svgPath) => {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const match = svg.match(/<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"/i);
    if (!match) return { width: 640, height: 900 };
    return { width: Number(match[1]), height: Number(match[2]) };
};

const renderSvgWithCanvas = async (svgPath, outputPath) => {
    const { width, height } = svgSize(svgPath);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const image = await loadImage(svgPath);
    ctx.drawImage(image, 0, 0, width, height);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
};

const renderSvgWithPuppeteer = async (browser, svgPath, outputPath) => {
    const { width, height } = svgSize(svgPath);
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#eef7fb}img{display:block;width:${width}px;height:${height}px}</style></head><body><img src="${pathToFileURL(svgPath).href}"></body></html>`,
        { waitUntil: 'load' }
    );
    await page.screenshot({ path: outputPath, type: 'png' });
    await page.close();
};

const renderSvg = async (browser, svgPath, outputPath) => {
    if (browser) {
        try {
            await renderSvgWithPuppeteer(browser, svgPath, outputPath);
            return;
        } catch (_) {}
    }
    await renderSvgWithCanvas(svgPath, outputPath);
};

const writeTransferPreview = async () => {
    const tx = {
        customId: 'DOC-API-2608-0001',
        amount: 1250,
        vodafoneNumber: '01098765432',
        companyName: 'شركة الأهرام التجريبية'
    };
    const apiResult = {
        reference_number: '28059087',
        external_transaction_id: '50011611',
        transaction_time: '03/08/2026 12:20 PM'
    };

    let buffer = await generateCustomReceipt(tx, apiResult);
    if (!buffer) {
        const receiptBase64 = await generateReceiptBase64({
            amount: tx.amount,
            walletNumber: tx.vodafoneNumber,
            referenceNumber: apiResult.reference_number,
            customId: tx.customId,
            accountName: tx.companyName,
            serviceName: 'تحويل API',
            date: apiResult.transaction_time
        });
        buffer = Buffer.from(receiptBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }

    fs.writeFileSync(path.join(outDir, 'transfer-receipt.jpg'), buffer);
};

const main = async () => {
    ensureDir(outDir);

    const samples = [
        {
            name: 'deposit-receipt.png',
            proofId: createDepositReceiptProof({
                customId: 'DOC-DEP-2608-0001',
                accountName: 'شركة الأهرام التجريبية',
                accountCode: 'CL-10024',
                amount: 1500,
                balanceAfter: 9250.75,
                notes: 'إيداع تجريبي للتوثيق',
                createdAt: new Date('2026-08-03T10:00:00Z'),
                type: 'deposit'
            })
        },
        {
            name: 'balance-transfer-receipt.png',
            proofId: createBalanceTransferReceiptProof({
                transferId: 'DOC-BTR-2608-0001',
                sourceName: 'حساب شركة الأهرام',
                sourceCode: 'CL-10024',
                targetName: 'حساب فرع طرابلس',
                targetCode: 'CL-20077',
                amount: 850,
                sourceBalanceBefore: 9250.75,
                sourceBalanceAfter: 8400.75,
                targetBalanceBefore: 2100,
                targetBalanceAfter: 2950,
                notes: 'تحويل داخلي للتوثيق',
                createdAt: new Date('2026-08-03T10:15:00Z')
            })
        },
        {
            name: 'cancellation-receipt.png',
            proofId: createCancellationReceiptProof({
                tx: {
                    _id: 'tx-doc-cancel',
                    customId: 'DOC-CAN-2608-0001',
                    status: 'cancelled_by_admin',
                    vodafoneNumber: '01012345678',
                    accountName: 'عميل تجريبي',
                    transferType: 'vodafone',
                    amount: 500
                },
                reason: 'طلب العميل إلغاء العملية',
                cancellationNumber: 'DOC-CAN-2608-0001',
                performedBy: 'الإدارة',
                cancelledAt: new Date('2026-08-03T10:30:00Z')
            })
        }
    ];

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
    } catch (_) {
        browser = null;
    }

    for (const sample of samples) {
        await renderSvg(browser, proofPath(sample.proofId), path.join(outDir, sample.name));
    }

    await writeTransferPreview();

    if (browser) await browser.close();
    console.log(`Receipt previews written to ${outDir}`);
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
