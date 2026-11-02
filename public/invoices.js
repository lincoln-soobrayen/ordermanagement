(function () {
  const timers = new WeakMap();
  const selectAll = document.getElementById("invoice-select-all");
  const bulkBar = document.getElementById("invoice-bulk-bar");
  const bulkCount = document.getElementById("invoice-bulk-count");
  const bulkForm = document.getElementById("invoices-bulk-form");

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-ok", "is-error");
    if (kind) el.classList.add(kind);
  }

  function rowChecks() {
    return Array.from(document.querySelectorAll(".invoice-row-check"));
  }

  function syncBulkBar() {
    const checks = rowChecks();
    const selected = checks.filter((c) => c.checked);
    const n = selected.length;
    if (bulkBar) bulkBar.hidden = n === 0;
    if (bulkCount) {
      bulkCount.textContent = n === 1 ? "1 selected" : `${n} selected`;
    }
    if (selectAll && checks.length) {
      selectAll.checked = selected.length === checks.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
    }
  }

  selectAll?.addEventListener("change", () => {
    const on = Boolean(selectAll.checked);
    rowChecks().forEach((c) => {
      c.checked = on;
    });
    syncBulkBar();
  });

  document.addEventListener("change", (event) => {
    if (event.target && event.target.classList && event.target.classList.contains("invoice-row-check")) {
      syncBulkBar();
    }
  });

  bulkForm?.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    if (!submitter || submitter.getAttribute("formaction")) return;
    const n = rowChecks().filter((c) => c.checked).length;
    if (!n) {
      event.preventDefault();
      return;
    }
    const action = submitter.value === "paid" ? "paid" : "unpaid";
    if (!window.confirm(`Mark ${n} order${n === 1 ? "" : "s"} as ${action}?`)) {
      event.preventDefault();
    }
  });

  document.querySelectorAll(".invoice-number-form").forEach((wrap) => {
    const orderId = wrap.getAttribute("data-order-id");
    const input = wrap.querySelector('input[name="invoice_number"]');
    const button = wrap.querySelector(".invoice-number-save");
    const status = wrap.querySelector(".invoice-save-status");
    if (!orderId || !input || !button) return;

    async function saveNumber() {
      const previousLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Saving…";
      setStatus(status, "", null);

      const prevTimer = timers.get(wrap);
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
        timers.set(wrap, timer);
      } catch (err) {
        setStatus(status, err.message || "Could not save", "is-error");
      } finally {
        button.disabled = false;
        button.textContent = previousLabel || "Save";
      }
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      saveNumber();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveNumber();
      }
    });
  });

  syncBulkBar();
})();
