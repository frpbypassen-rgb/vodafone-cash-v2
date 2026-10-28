(() => {
  "use strict";
  const root = document.querySelector("[data-admin-portal-settings]");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "1";
  const get = (key) => root.querySelector("[data-aps-" + key + "]");
  const form = get("integrations");
  let busy = false,
    dirty = false;
  const tell = (text, error = false) => {
    get("result").textContent = text;
    get("result").classList.toggle("is-error", error);
  };
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };
  const meta = (row) =>
    [
      row.updatedBy && "آخر تعديل: " + row.updatedBy,
      row.updatedAt && new Date(row.updatedAt).toLocaleString("ar-LY"),
    ]
      .filter(Boolean)
      .join(" · ");
  const api = async (body) => {
    const response = await fetch(root.dataset.url, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body
          ? {
              "Content-Type": "application/json",
              "X-CSRF-Token": root.dataset.csrf,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : {};
    if (!response.ok || !payload.success)
      throw new Error(payload.error || "تعذر الاتصال. حدّث الصفحة.");
    return payload.data;
  };
  const rowNode = (label, detail) => {
    const row = node("div");
    row.className = "aps-row";
    const text = node("div", label);
    if (detail) text.append(node("small", detail));
    row.append(text);
    return row;
  };
  const mutate = async (body) => {
    if (busy) return;
    busy = true;
    root.querySelectorAll("button,input").forEach((el) => {
      el.disabled = true;
    });
    try {
      const data = await api(body);
      dirty = false;
      render(data);
      tell("تم الحفظ. تظهر الحالة نفسها في البوابة.");
    } catch (error) {
      tell(error.message, true);
    } finally {
      busy = false;
      root.querySelectorAll("button,input").forEach((el) => {
        el.disabled = false;
      });
    }
  };
  const toggle = (row, resource, section, enabled, label) => {
    const wrap = node("label"),
      input = node("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.setAttribute("aria-label", label);
    input.dataset.apsToggle = section;
    input.dataset.resourceId = resource.id;
    input.addEventListener("change", () => {
      const selected = input.checked;
      input.checked = enabled;
      void mutate({
        section,
        id: resource.id,
        enabled: selected,
        revision: resource.revision,
      });
    });
    wrap.append(input, node("span", enabled ? " مفعّل" : " متوقف"));
    row.append(wrap);
  };
  const rows = (key, values, build, empty) => {
    const target = get(key);
    target.replaceChildren(
      ...(values.length ? values.map(build) : [node("p", empty)]),
    );
  };
  const render = (data) => {
    form.elements.apiEnabled.checked = data.access.apiEnabled;
    form.elements.webhooksEnabled.checked = data.access.webhooksEnabled;
    form.elements.revision.value = data.access.revision;
    get("key").textContent =
      (data.access.apiEnabled ? "API مسموح" : "API متوقف من الإدارة") +
      " · " +
      (data.access.keyActive ? "المفتاح نشط" : "المفتاح غير نشط") +
      (data.access.keyHint ? " · …" + data.access.keyHint : "") +
      " · قائمة IP: " + (data.access.ipAllowlistEnabled ? "مفعّلة" : "غير مفعّلة") +
      (data.access.allowedIps?.length ? " · " + data.access.allowedIps.join("، ") : "") +
      " · " +
      meta(data.access);
    rows(
      "emails",
      data.emails,
      (item) => {
        const row = rowNode(
          item.actor + " — " + (item.email || "لا يوجد بريد مؤكّد"),
          (item.verified ? "مؤكّد" : "بانتظار تأكيد البريد") +
            (item.pendingEmail
              ? " · عنوان قيد التأكيد: " + item.pendingEmail
              : "") +
            " · " +
            meta(item),
        );
        toggle(row, item, "email", item.enabled, "الكشف اليومي: " + item.actor);
        return row;
      },
      "لم يضف الحساب بريدًا للكشف اليومي بعد.",
    );
    rows(
      "telegram",
      data.telegram,
      (item) => {
        const row = rowNode(
          item.name,
          [
            item.username ? "@" + item.username : item.chatHint,
            item.linked ? "مرتبط" : "بانتظار الربط",
            meta(item),
          ]
            .filter(Boolean)
            .join(" · "),
        );
        if (item.linked)
          toggle(
            row,
            item,
            "telegram",
            item.enabled,
            "إيصالات Telegram: " + item.name,
          );
        const rename = node("button", "تعديل الاسم");
        rename.type = "button";
        rename.className = "btn btn-outline-secondary";
        rename.addEventListener("click", () => {
          const name = window.prompt("اسم حساب Telegram", item.name);
          if (name && name !== item.name)
            void mutate({
              section: "telegram",
              action: "rename",
              id: item.id,
              name,
              revision: item.revision,
            });
        });
        row.append(rename);
        return row;
      },
      "لا توجد حسابات Telegram مرتبطة.",
    );
    rows(
      "push",
      data.push,
      (item, index) => {
        const row = rowNode(item.actor + " — متصفح " + (index + 1), meta(item));
        toggle(
          row,
          item,
          "push",
          item.enabled,
          "إشعارات المتصفح: " + item.actor,
        );
        return row;
      },
      "لا توجد متصفحات مشتركة.",
    );
    get("profile").textContent = [
      data.profile.name,
      data.profile.phone,
      ...Object.values(data.profile.businessProfile).filter(
        (value) => typeof value === "string" && value,
      ),
    ]
      .filter(Boolean)
      .join(" · ");
    rows(
      "actors",
      data.actors,
      (item) =>
        rowNode(
          item.name,
          "Authenticator: " +
            (item.mfaEnabled ? "مفعّل" : "غير مفعّل") +
            " · بريد الدخول: " +
            (item.email || "غير مضاف") +
            " · OTP بالبريد: " +
            (item.emailOtpEnabled ? "مفعّل" : "متوقف") +
            " · قناة الدخول: " + (item.loginOtpChannel === 'telegram' ? 'تليجرام' : item.loginOtpChannel === 'email' ? 'البريد' : 'متوقفة') +
            " · تليجرام الدخول: " + (item.telegramLoginVerified ? 'مؤكد' : 'غير مرتبط') + (item.telegramLoginAccount ? ' @' + item.telegramLoginAccount : '') +
            (item.theme ? " · المظهر: " + item.theme : "") +
            " · كثافة العرض: " +
            (item.density === "compact" ? "مضغوطة" : "مريحة"),
        ),
      "",
    );
    rows(
      "webhooks",
      data.webhooks,
      (item) =>
        rowNode(
          item.name,
          item.url +
            " · " +
            (item.enabled && data.access.webhooksEnabled ? "مفعّل" : "متوقف") +
            " · " +
            item.events.join("، "),
        ),
      "لا توجد روابط Webhooks.",
    );
  };
  const refresh = async () => {
    if (!busy && !dirty) render(await api());
  };
  form.addEventListener("input", () => {
    dirty = true;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void mutate({
      section: "integrations",
      apiEnabled: form.elements.apiEnabled.checked,
      webhooksEnabled: form.elements.webhooksEnabled.checked,
      revision: Number(form.elements.revision.value),
    });
  });
  get("refresh").addEventListener("click", () => {
    if (
      dirty &&
      !window.confirm("تجاهل التعديلات غير المحفوظة وجلب الحالة الحالية؟")
    )
      return;
    dirty = false;
    refresh()
      .then(() => tell("تم تحديث الحالة."))
      .catch((error) => tell(error.message, true));
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh().catch(() => {});
  });
  window.setInterval(() => {
    if (!document.hidden) refresh().catch(() => {});
  }, 15000);
  refresh().catch((error) => tell(error.message, true));
})();
