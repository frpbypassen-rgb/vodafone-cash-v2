const { createCanvas, registerFont, loadImage } = require('canvas');
const fs = require('fs');

async function generateReceipt(data) {
    const width = 600;
    const height = 900;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#f8f8f8'; // Off-white
    ctx.fillRect(0, 0, width, height);
    
    // Add some noise or shadow if needed (skipping for simplicity)
    
    // Fonts (Assuming Tajawal or default sans-serif is available)
    // If not, we fall back to generic 'sans-serif' which might not render Arabic nicely without a font file.
    // Windows usually has 'Arial' or 'Segoe UI' which supports Arabic.
    
    // Title
    ctx.fillStyle = '#000';
    ctx.font = 'bold 48px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Ahram-Pay', width / 2, 80);
    
    // Line below title
    ctx.beginPath();
    ctx.moveTo(150, 110);
    ctx.lineTo(450, 110);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Checkmark circle (mocking icon)
    ctx.beginPath();
    ctx.arc(width / 2, 160, 25, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px Arial';
    ctx.fillText('✓', width / 2, 168);

    // Subtitle
    ctx.fillStyle = '#000';
    ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
    ctx.fillText('عملية ناجحة', width / 2, 240);
    
    // Dashed separator
    function drawDashedLine(y) {
        ctx.beginPath();
        ctx.setLineDash([5, 10]);
        ctx.moveTo(80, y);
        ctx.lineTo(520, y);
        ctx.stroke();
        ctx.setLineDash([]);
    }
    
    drawDashedLine(280);

    ctx.textAlign = 'right';
    let startY = 340;
    const rowHeight = 60;
    
    // Fields
    const rows = [
        { label: 'اسم الخدمة :', value: 'تحويل كاش' },
        { label: 'رقم المحفظة :', value: data.walletNumber },
        { label: 'القيمة :', value: `${data.amount} ج.م` },
        { label: 'الرقم المرسل :', value: data.senderPhone },
        { label: 'رقم العملية :', value: data.customId },
        { label: 'الحساب :', value: data.accountName },
        { label: 'التاريخ :', value: data.date }
    ];

    rows.forEach(row => {
        ctx.font = 'bold 24px "Segoe UI", Arial, sans-serif';
        // Draw label (Right aligned)
        ctx.textAlign = 'right';
        ctx.fillText(row.label, 500, startY);
        // Draw value (Left aligned or centered-left)
        ctx.textAlign = 'left';
        ctx.fillText(row.value, 100, startY);
        
        drawDashedLine(startY + 20);
        startY += rowHeight;
    });

    // Warning Box
    ctx.fillStyle = '#eaeaea';
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(80, startY + 20, 440, 100, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px "Segoe UI", Arial, sans-serif';
    ctx.fillText('الرقم المحول منه للتأكيد فقط على وصول العملية للجهة', width / 2, startY + 50);
    ctx.fillText('الاخرى، لا تقم نهائياً بالتحويل اليه مره اخرى', width / 2, startY + 75);
    ctx.fillText('حتى لا تخسر اموالك .', width / 2, startY + 105);

    // Footer
    drawDashedLine(startY + 150);
    ctx.font = 'bold 20px Arial';
    ctx.fillText('★ ★ ★', width / 2, startY + 190);
    ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
    ctx.fillText('Power by AhramPay', width / 2, startY + 220);
    
    // ZigZag Bottom (mocking receipt tear)
    ctx.fillStyle = '#fff'; // Assuming it's printed on white bg and tearing shows the back? 
    // Actually the receipt background IS white. To make zigzag, we can draw a zigzag path at the bottom and fill with transparent if it's a PNG.
    
    const buffer = canvas.toBuffer('image/jpeg');
    fs.writeFileSync('test_receipt.jpg', buffer);
    console.log('Receipt saved to test_receipt.jpg');
}

generateReceipt({
    amount: 5000,
    walletNumber: '01108172258',
    senderPhone: '011*****258',
    customId: 'ATT-2606-0002',
    accountName: 'شركة الاهرام : 01108172258',
    date: '2026/06/07'
});
