/* exported savedTheme */
const savedTheme = localStorage.getItem('ahram_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
document.documentElement.setAttribute('data-bs-theme', savedTheme);

window.showReceiptModal = function (proofImage, proofImagesStr) {
    let images = [];
    if (proofImagesStr) images = proofImagesStr.split(',').filter((i) => i.trim() !== '');
    if (proofImage && proofImage !== 'undefined' && proofImage !== 'null' && !images.includes(proofImage))
        images.push(proofImage);
    if (images.length === 0) return Swal.fire('تنبيه', 'لا توجد صورة إيصال متاحة لهذه العملية', 'info');
    let html = '<div class="receipt-container" style="text-align: center;">';
    images.forEach((img) => {
        let src = img;
        if (!img.startsWith('http') && !img.startsWith('data:') && img.includes('.'))
            src = '/uploads/proofs/' + img;
        html += `<img src="${src}" class="img-fluid rounded mb-3 shadow-sm border" style="max-height: 50vh; max-width: 100%; object-fit: contain;" />`;
    });
    html += '</div>';
    const mappedImages = images.map((img) =>
        !img.startsWith('http') && !img.startsWith('data:') && img.includes('.')
            ? '/uploads/proofs/' + img
            : img
    );
    const imagesJoined = mappedImages.join(',');
    Swal.fire({
        title: '<i class="fa-solid fa-receipt me-2 text-success"></i> إيصال التحويل',
        html,
        showCloseButton: true,
        showConfirmButton: false,
        footer: `
                    <div class="d-flex justify-content-center gap-2 w-100 mt-2 px-3 pb-2">
                        <button class="btn btn-success fw-bold flex-fill py-2" onclick="downloadImages('${imagesJoined}')"><i class="fa-solid fa-download me-1"></i> تحميل</button>
                        <button class="btn btn-primary fw-bold flex-fill py-2" onclick="shareImages('${imagesJoined}')"><i class="fa-solid fa-share-nodes me-1"></i> مشاركة</button>
                    </div>
                `,
        customClass: { popup: 'swal2-popup' },
    });
};

window.downloadImages = async function (imagesStr) {
    const images = imagesStr.split(',');
    for (let i = 0; i < images.length; i++) {
        try {
            const response = await fetch(images[i]);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `receipt_${Date.now()}_${i}.jpg`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Download error:', e);
        }
    }
};

window.shareImages = async function (imagesStr) {
    const images = imagesStr.split(',');
    if (navigator.share) {
        try {
            const filesArray = [];
            for (let i = 0; i < images.length; i++) {
                const response = await fetch(images[i]);
                const blob = await response.blob();
                filesArray.push(new File([blob], `receipt_${i}.jpg`, { type: blob.type || 'image/jpeg' }));
            }
            if (navigator.canShare && navigator.canShare({ files: filesArray })) {
                await navigator.share({
                    files: filesArray,
                    title: 'إيصال التحويل',
                    text: 'مرفق إيصال العملية',
                });
            } else {
                await navigator.share({ title: 'إيصال التحويل', url: images[0] });
            }
        } catch (error) {
            console.error('Error sharing:', error);
        }
    } else {
        Swal.fire(
            'تنبيه',
            'المشاركة المباشرة غير مدعومة في متصفحك، يرجى استخدام زر التحميل بدلاً من ذلك.',
            'info'
        );
    }
};
