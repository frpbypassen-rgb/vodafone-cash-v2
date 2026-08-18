'use strict';

const DEFINITIONS = Object.freeze({
    executor_task_new: {
        channelId: 'executor_tasks_v2',
        sound: 'ahram_task_arrival',
        preferenceKey: 'tasks',
        priority: 'urgent',
        route: 'tasks'
    },
    executor_task_routed: {
        channelId: 'executor_routed_tasks_v1',
        sound: 'ahram_task_assigned',
        preferenceKey: 'tasks',
        priority: 'urgent',
        route: 'tasks'
    },
    executor_task_reminder: {
        channelId: 'executor_task_reminders_v1',
        sound: 'ahram_task_reminder',
        preferenceKey: 'reminders',
        priority: 'urgent',
        route: 'tasks'
    },
    executor_urgent_alert: {
        channelId: 'executor_urgent_alerts_v2',
        sound: 'ahram_urgent_alarm',
        preferenceKey: 'urgent',
        priority: 'critical',
        route: 'tasks'
    },
    executor_task_accepted: {
        channelId: 'executor_task_status_v1',
        sound: 'ahram_status_update',
        preferenceKey: 'taskStatus',
        priority: 'normal',
        route: 'tasks'
    },
    executor_task_completed: {
        channelId: 'executor_task_success_v1',
        sound: 'ahram_success',
        preferenceKey: 'taskStatus',
        priority: 'normal',
        route: 'reports'
    },
    executor_task_cancelled: {
        channelId: 'executor_task_cancellation_v1',
        sound: 'ahram_cancellation',
        preferenceKey: 'taskStatus',
        priority: 'high',
        route: 'reports'
    },
    executor_support_reply: {
        channelId: 'executor_support_v1',
        sound: 'ahram_support',
        preferenceKey: 'support',
        priority: 'high',
        route: 'support'
    },
    executor_balance_warning: {
        channelId: 'executor_finance_v1',
        sound: 'ahram_balance_warning',
        preferenceKey: 'balance',
        priority: 'high',
        route: 'settings'
    },
    executor_security_alert: {
        channelId: 'executor_security_v1',
        sound: 'ahram_security',
        preferenceKey: 'security',
        priority: 'high',
        route: 'settings'
    },
    executor_report_ready: {
        channelId: 'executor_reports_v1',
        sound: 'ahram_report_ready',
        preferenceKey: 'reports',
        priority: 'normal',
        route: 'reports'
    },
    executor_task_claimed: {
        channelId: 'executor_silent_updates_v1',
        sound: '',
        preferenceKey: 'tasks',
        priority: 'silent',
        route: 'tasks'
    },
    executor_task_closed: {
        channelId: 'executor_silent_updates_v1',
        sound: '',
        preferenceKey: 'tasks',
        priority: 'silent',
        route: 'tasks'
    }
});

const DEFAULT_PREFERENCES = Object.freeze({
    tasks: true,
    reminders: true,
    urgent: true,
    taskStatus: true,
    support: true,
    balance: true,
    security: true,
    reports: true
});

const definitionFor = (category) => DEFINITIONS[category] || {
    channelId: 'executor_task_status_v1',
    sound: 'ahram_status_update',
    preferenceKey: 'taskStatus',
    priority: 'normal',
    route: 'tasks'
};

module.exports = {
    DEFINITIONS,
    DEFAULT_PREFERENCES,
    definitionFor
};
