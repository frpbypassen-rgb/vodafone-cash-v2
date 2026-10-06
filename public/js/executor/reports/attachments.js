/* exported setupVoiceRecorder, uploadVoiceNote */
function setupVoiceRecorder(txId) {
    let mediaRecorder = null;
    let chunks = [];
    const recordBtn = document.getElementById('voiceRecordBtn');
    const stopBtn = document.getElementById('voiceStopBtn');
    const recorderArea = document.getElementById('voiceRecorderArea');
    const fileInput = document.getElementById('voiceFileInput');
    const uploadBtn = document.getElementById('voiceUploadBtn');

    if (recordBtn) {
        recordBtn.onclick = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                chunks = [];
                mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
                mediaRecorder.onstop = async () => {
                    const blob = new Blob(chunks, { type: 'audio/webm' });
                    await uploadVoiceNote(txId, blob);
                    stream.getTracks().forEach((t) => t.stop());
                    recorderArea.classList.add('d-none');
                };
                mediaRecorder.start();
                recorderArea.classList.remove('d-none');
            } catch {
                Swal.fire('تنبيه', 'لا يمكن الوصول إلى الميكروفون.', 'warning');
            }
        };
    }
    if (stopBtn) stopBtn.onclick = () => mediaRecorder?.stop();
    if (uploadBtn && fileInput) {
        uploadBtn.onclick = async () => {
            if (!fileInput.files[0]) return Swal.fire('تنبيه', 'اختر ملف صوتي أولاً.', 'warning');
            await uploadVoiceNote(txId, fileInput.files[0]);
        };
    }
}

async function uploadVoiceNote(txId, blob) {
    try {
        const reader = new FileReader();
        reader.onloadend = async () => {
            const base64 = reader.result;
            const res = await executorApiFetch(`/executor-portal/api/voice-note/${txId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base64 }),
            });
            const data = await res.json();
            if (data.success) {
                Swal.fire({
                    icon: 'success',
                    title: 'تم حفظ الملاحظة الصوتية',
                    timer: 1200,
                    showConfirmButton: false,
                });
                if (lastReportRequest) fetchReport();
            } else throw new Error(data.error);
        };
        reader.readAsDataURL(blob);
    } catch (e) {
        Swal.fire('خطأ', e.message || 'تعذر رفع الملاحظة الصوتية', 'error');
    }
}
