(() => {
  "use strict";
  const input = document.querySelector("[data-server-density]");
  if (!input) return;
  const result = document.createElement("small");
  result.setAttribute("role", "status");
  input.after(result);
  let state = {
      density: input.value,
      revision: Number(input.dataset.revision),
    },
    busy = false;
  const api = async (body) => {
    const response = await fetch(
      input.dataset.base + "/api/display-preferences",
      {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(body
            ? {
                "Content-Type": "application/json",
                "X-CSRF-Token":
                  (window.agentPortal || window.businessPortal)?.csrfToken ||
                  "",
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const payload = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : {};
    if (!response.ok || !payload.success)
      throw new Error(payload.error || "تعذر تحديث تفضيل العرض.");
    state = payload.data;
    input.value = state.density;
    document.documentElement.dataset.density = state.density;
  };
  input.addEventListener("change", async () => {
    if (busy) return;
    busy = true;
    input.disabled = true;
    try {
      await api({ density: input.value, revision: state.revision });
      result.textContent = "تم الحفظ على الحساب.";
    } catch (error) {
      result.textContent = error.message;
      try {
        await api();
      } catch (_) {}
    } finally {
      busy = false;
      input.disabled = false;
    }
  });
  const refresh = () => {
    if (!busy && !document.hidden) api().catch(() => {});
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
})();
