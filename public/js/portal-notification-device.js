(() => {
  "use strict";
  const input = document.querySelector("[data-server-notifications]");
  if (!input) return;
  const result = document.querySelector("[data-notification-device-result]");
  const base = input.dataset.base;
  let state,
    subscription,
    registration,
    busy = false;
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const tell = (text) => {
    if (result) result.textContent = text;
  };
  const api = async (action, body = {}) => {
    const response = await fetch(base + "/api/notification-device/" + action, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token":
          (window.agentPortal || window.businessPortal)?.csrfToken || "",
      },
      body: JSON.stringify(body),
    });
    const payload = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : {};
    if (!response.ok || !payload.success)
      throw new Error(payload.error || "تعذر تحديث إعداد الإشعارات.");
    return payload.data;
  };
  const render = () => {
    input.checked = Boolean(state?.enabled);
    input.dispatchEvent(new Event("notificationstatesync"));
  };
  const refresh = async () => {
    if (busy || document.hidden) return;
    if (supported) {
      registration = await navigator.serviceWorker.getRegistration();
      subscription = registration
        ? await registration.pushManager.getSubscription()
        : null;
    }
    state = await api("status", { endpoint: subscription?.endpoint || "" });
    render();
  };
  input.checked = false;
  input.addEventListener("change", async () => {
    if (busy) return;
    const enabled = input.checked;
    render();
    busy = true;
    input.disabled = true;
    try {
      if (!state) throw new Error("انتظر تحميل الحالة أولاً.");
      if (enabled && !subscription) {
        if (!supported)
          throw new Error("إشعارات الويب غير مدعومة في هذا المتصفح.");
        if (!state.configured)
          throw new Error("إشعارات الويب غير مهيأة على الخادم.");
        if ((await Notification.requestPermission()) !== "granted")
          throw new Error("اسمح بالإشعارات من إعدادات المتصفح.");
        registration =
          registration ||
          (await navigator.serviceWorker.register("/rate-alert-sw.js"));
        if (!registration.active) {
          await navigator.serviceWorker.ready;
          registration = await navigator.serviceWorker.getRegistration();
        }
        const encoded = state.publicKey.replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(
          atob(encoded + "=".repeat((4 - (encoded.length % 4)) % 4)),
          (char) => char.charCodeAt(0),
        );
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        });
      }
      state = await api("preferences", {
        endpoint: subscription?.endpoint || "",
        subscription: subscription?.toJSON(),
        enabled,
        revision: state.revision,
      });
      render();
      tell(
        enabled
          ? "تم تفعيل هذا المتصفح وحفظه في الحساب."
          : "تم إيقاف الإرسال لهذا المتصفح.",
      );
    } catch (error) {
      tell(error.message);
    } finally {
      busy = false;
      input.disabled = false;
      refresh().catch(() => {});
    }
  });
  window.setInterval(() => refresh().catch(() => {}), 15000);
  document.addEventListener("visibilitychange", () =>
    refresh().catch(() => {}),
  );
  window.addEventListener("focus", () => refresh().catch(() => {}));
  refresh().catch((error) => tell(error.message));
})();
