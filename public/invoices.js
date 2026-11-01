(function () {
  const timers = new WeakMap();

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-ok", "is-error");
    if (kind) el.classList.add(kind);
  }

  document.querySelectorAll(".invoice-number-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const orderId = form.getAttribute("data-order-id");
      const input = form.querySelector('input[name="invoice_number"]');
      const button = form.querySelector('button[type="submit"]');
      const status = form.querySelector(".invoice-save-status");
      if (!orderId || !input || !button) return;

      const previousLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Saving…";
      setStatus(status, "", null);

      const prevTimer = timers.get(form);
      if (prevTimer) window.clearTimeout(prevTimer);

      try {
        const res = await fetch(`/invoices/${orderId}/number`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ invoice_number: input.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Could not save invoice number");
        }
        input.value = data.invoice_number == null ? "" : String(data.invoice_number);
        setStatus(status, "Saved", "is-ok");
        const timer = window.setTimeout(() => setStatus(status, "", null), 1500);
        timers.set(form, timer);
      } catch (err) {
        setStatus(status, err.message || "Could not save", "is-error");
      } finally {
        button.disabled = false;
        button.textContent = previousLabel || "Save";
      }
    });
  });
})();
