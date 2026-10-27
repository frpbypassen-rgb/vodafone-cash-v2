(() => {
  "use strict";
  const root = document.querySelector("[data-merchant-detail]");
  if (!root) return;
  root
    .querySelector("[data-merchant-tab]")
    ?.addEventListener("change", (event) => {
      window.location.assign(event.target.value);
    });
  const form = root.querySelector("[data-company-detail-rate-form]");
  const mode = form?.querySelector("[data-company-detail-rate-mode]");
  const sync = () =>
    form
      ?.querySelectorAll("[data-company-detail-rate-input]")
      .forEach((input) => {
        input.disabled = mode.value !== "custom";
      });
  mode?.addEventListener("change", sync);
  sync();
  const aliases = {
    "#merchant-integration-access": "settings",
    "#company-api-integration": "settings",
    "#owner-email-otp": "profile",
    "#company-pricing": "finance",
  };
  const openHash = () => {
    const tab = aliases[window.location.hash];
    if (!tab || root.dataset.tab === tab) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    url.searchParams.delete("page");
    window.location.replace(url.href);
  };
  window.addEventListener("hashchange", openHash);
  openHash();
})();
