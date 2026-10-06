/* exported refreshVisibleExecutorTasks, scheduleLiveTasksPoll */
const refreshVisibleExecutorTasks = () => {
    if (!document.hidden) refreshTasks();
};
window.addEventListener('offline', () => {
    showTaskBoardStatus('انقطع الاتصال. تبقى آخر المهام ظاهرة حتى يعود الإنترنت.', { offline: true });
});
window.addEventListener('online', () => {
    hideTaskBoardStatus();
    refreshVisibleExecutorTasks();
});
const scheduleLiveTasksPoll = () => {
    window.clearTimeout(liveTasksPollTimer);
    liveTasksPollTimer = window.setTimeout(async () => {
        await refreshVisibleExecutorTasks();
        scheduleLiveTasksPoll();
    }, liveTasksPollMs);
};
// التحديث الفوري يصل عبر الإشعارات؛ نستخدم فحصاً احتياطياً أخف أثناء الهدوء.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        window.clearTimeout(liveTasksPollTimer);
        return;
    }
    refreshVisibleExecutorTasks();
    scheduleLiveTasksPoll();
});
refreshVisibleExecutorTasks();
scheduleLiveTasksPoll();
