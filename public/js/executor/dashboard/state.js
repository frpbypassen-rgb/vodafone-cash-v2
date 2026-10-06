/* exported activeTasksIds, activeTaskUrl, currentCompletingId, currentCompletingTransferType, currentCompletingBankName, currentEmergencyId, selectedFilesArray, lastTasksHash, liveTasksPollMs, liveTasksPollTimer, dismissedAlertsIds */
let activeTasksIds = [];
const activeTaskUrl = (id) => '/executor-portal/active-task/' + encodeURIComponent(id);
let currentCompletingId = null;
let currentCompletingTransferType = '';
let currentCompletingBankName = '';
let currentEmergencyId = null;
let selectedFilesArray = [];
let lastTasksHash = null;
let liveTasksPollMs = 12000;
let liveTasksPollTimer = null;
// 🚀 ذاكرة ذكية تمنع إعادة عرض أي إنذار تم إيقافه محلياً
let dismissedAlertsIds = new Set();
