// Label wide table cells with their column header so the CSS can stack rows as cards on phones.
// Runs before DOMContentLoaded (this script sits at the end of <body>) to avoid a flash of the wide table.
function stackTables() {
  document.querySelectorAll("table.data-table").forEach((table) => {
    const headRow = table.tHead?.rows[0];
    if (!headRow) return;
    const labels = [];
    for (const th of headRow.cells) {
      for (let i = 0; i < (th.colSpan || 1); i++) labels.push(th.textContent.trim());
    }
    if (labels.length <= 3) return;
    table.classList.add("stack-table");
    const rows = [...table.tBodies].flatMap((body) => [...body.rows]);
    if (table.tFoot) rows.push(...table.tFoot.rows);
    rows.forEach((row) => {
      if (row.cells.length === 1 && row.cells[0].colSpan > 1) {
        row.classList.add("full-row");
        return;
      }
      let col = 0;
      for (const cell of row.cells) {
        if (!cell.hasAttribute("data-label") && labels[col]) cell.setAttribute("data-label", labels[col]);
        col += cell.colSpan || 1;
      }
    });
  });
  addViewToggle();
}

// Phones: let the page's main tables switch between cards and the classic scrollable list.
function addViewToggle() {
  const tables = [...document.querySelectorAll("table.stack-table")].filter(
    (t) => !t.classList.contains("compact") && !t.parentElement.closest("table")
  );
  if (tables.length === 0) return;

  tables.forEach((table) => {
    if (table.parentElement.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.before(wrap);
    wrap.append(table);
  });

  const storageKey = `tableView:${window.location.pathname}`;
  const toggle = document.createElement("div");
  toggle.className = "view-toggle";
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "Layout");
  toggle.innerHTML =
    '<button type="button" data-view="cards">▦ Cards</button>' +
    '<button type="button" data-view="list">☰ List</button>';
  tables[0].parentElement.before(toggle);

  function applyView(view) {
    tables.forEach((table) => {
      table.classList.toggle("stack-table", view === "cards");
      table.classList.toggle("list-view", view === "list");
    });
    toggle.querySelectorAll("button").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.view === view));
    });
  }

  let saved = "cards";
  try {
    saved = localStorage.getItem(storageKey) === "list" ? "list" : "cards";
  } catch (err) {
    // Storage blocked: default to cards
  }
  applyView(saved);

  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    applyView(btn.dataset.view);
    try {
      localStorage.setItem(storageKey, btn.dataset.view);
    } catch (err) {
      // Storage blocked: the choice lasts until the page reloads
    }
  });
}
stackTables();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker registration failed", err));
  });
}

// Chrome (Android/desktop) fires this when the app can be installed; show our own button for it.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const installButton = document.getElementById("install-app");
  if (installButton) installButton.hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  const installButton = document.getElementById("install-app");
  if (installButton) installButton.hidden = true;
});

document.addEventListener("DOMContentLoaded", () => {
  // Sidebar menu toggle
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const menuToggle = document.getElementById("menu-toggle");
  const sidebarClose = document.getElementById("sidebar-close");

  function openSidebar() {
    sidebar?.classList.add("open");
    overlay?.classList.add("open");
  }

  function closeSidebar() {
    sidebar?.classList.remove("open");
    overlay?.classList.remove("open");
  }

  menuToggle?.addEventListener("click", openSidebar);
  sidebarClose?.addEventListener("click", closeSidebar);
  overlay?.addEventListener("click", closeSidebar);

  // Highlight current nav item and open its Reports submenu if active
  document.querySelectorAll(".sidebar-link").forEach((link) => {
    const match = link.getAttribute("data-match");
    const insideSubmenu = link.closest(".sidebar-submenu");
    const isActive = match && (
      insideSubmenu
        ? window.location.pathname === match
        : window.location.pathname.startsWith(match)
    );
    if (isActive) {
      link.classList.add("active");
      const group = link.closest(".sidebar-group");
      if (group) group.classList.add("open");
    }
  });

  // Toggle Reports submenu when its parent link is clicked
  document.querySelectorAll(".sidebar-group > .sidebar-link").forEach((toggler) => {
    toggler.addEventListener("click", (e) => {
      const group = toggler.closest(".sidebar-group");
      if (!group) return;
      if (group.querySelector(".sidebar-link.active")) return;
      e.preventDefault();
      group.classList.toggle("open");
    });
  });

  // Auto-submit filter forms when status changes (keeps search button optional)
  document.querySelectorAll(".filters select").forEach((select) => {
    select.addEventListener("change", () => {
      select.closest("form")?.submit();
    });
  });

  // Confirm delete actions
  document.querySelectorAll("button[onclick*='confirm']").forEach((btn) => {
    const original = btn.getAttribute("onclick");
    btn.removeAttribute("onclick");
    btn.addEventListener("click", (e) => {
      if (original && !confirm(original.match(/'([^']+)'/)?.[1] || "Are you sure?")) {
        e.preventDefault();
      }
    });
  });

  // When creating/editing an order, selecting a lead navigates to a prefilled form
  const leadSelect = document.getElementById("lead-select");
  const path = window.location.pathname;
  const isNewOrder = path === "/orders/new";

  if (leadSelect) {
    leadSelect.addEventListener("change", () => {
      if (isNewOrder) {
        const leadOption = leadSelect.options[leadSelect.selectedIndex];
        const leadUrl = leadOption?.dataset?.url;
        if (leadUrl) window.location.href = leadUrl;
      }
    });
  }

  function formatCurrency(n) {
    return "Rs " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Sales order lines (multi-product order form)
  const salesOrderTableBody = document.getElementById("sales-order-lines-body");
  const salesOrderLineTemplate = document.getElementById("sales-order-line-template");
  const addLineButton = document.getElementById("add-order-line");
  const totalPriceDisplay = document.getElementById("total-price-display");
  const totalPriceDetail = document.getElementById("total-price-detail");
  const isSampleCheckbox = document.getElementById("is-sample");
  const noLinesMessage = document.getElementById("no-lines-message");

  if (salesOrderTableBody && salesOrderLineTemplate && window.salesOrderData) {
    const products = window.salesOrderData.products || [];
    let lines = (window.salesOrderData.lines || []).map((line) => ({
      product_id: line.product_id || "",
      quantity_kg: line.quantity_kg || "",
      quantity_sachets: line.quantity_sachets || "",
      quantity_cartons: line.quantity_cartons || "",
      unit_price: line.unit_price || "",
    }));

    function getProduct(id) {
      return products.find((p) => String(p.id) === String(id));
    }

    function renderLine(line, index) {
      const clone = salesOrderLineTemplate.content.cloneNode(true);
      const row = clone.querySelector("tr");
      row.dataset.index = index;

      const productSelect = clone.querySelector(".line-product");
      const kgInput = clone.querySelector(".line-qty-kg");
      const sachetsInput = clone.querySelector(".line-qty-sachets");
      const cartonsInput = clone.querySelector(".line-qty-cartons");
      const priceInput = clone.querySelector(".line-unit-price");
      const removeBtn = clone.querySelector(".remove-line");

      productSelect.value = line.product_id || "";
      kgInput.value = line.quantity_kg || "";
      sachetsInput.value = line.quantity_sachets || "";
      cartonsInput.value = line.quantity_cartons || "";
      priceInput.value = line.unit_price || "";

      productSelect.addEventListener("change", () => {
        const product = getProduct(productSelect.value);
        const isSample = isSampleCheckbox?.checked;
        if (product && !isSample && !priceInput.value) {
          priceInput.value = Number(product.selling_price).toFixed(2);
        }
        recalcRow(row);
      });

      kgInput.addEventListener("input", () => syncRowQuantities(row, "kg"));
      sachetsInput.addEventListener("input", () => syncRowQuantities(row, "sachets"));
      cartonsInput.addEventListener("input", () => syncRowQuantities(row, "cartons"));
      priceInput.addEventListener("input", () => recalcRow(row));

      removeBtn.addEventListener("click", () => {
        row.remove();
        updateTotals();
      });

      salesOrderTableBody.appendChild(clone);
      recalcRow(row);
    }

    function readRowPackaging(row) {
      const productSelect = row.querySelector(".line-product");
      const product = getProduct(productSelect.value);
      const kgPerSachet = product?.kg_per_sachet || 1;
      const sachetsPerCarton = product?.sachets_per_carton || 1;
      return {
        kgPerSachet: Math.max(parseFloat(kgPerSachet) || 1, 0.0001),
        sachetsPerCarton: Math.max(parseFloat(sachetsPerCarton) || 1, 0.0001),
      };
    }

    function syncRowQuantities(row, source) {
      const { kgPerSachet, sachetsPerCarton } = readRowPackaging(row);
      const kgInput = row.querySelector(".line-qty-kg");
      const sachetsInput = row.querySelector(".line-qty-sachets");
      const cartonsInput = row.querySelector(".line-qty-cartons");

      if (source === "kg") {
        const kg = parseFloat(kgInput.value) || 0;
        const sachets = kg / kgPerSachet;
        sachetsInput.value = sachets.toFixed(4);
        cartonsInput.value = (sachets / sachetsPerCarton).toFixed(4);
      } else if (source === "sachets") {
        const sachets = parseFloat(sachetsInput.value) || 0;
        kgInput.value = (sachets * kgPerSachet).toFixed(4);
        cartonsInput.value = (sachets / sachetsPerCarton).toFixed(4);
      } else if (source === "cartons") {
        const cartons = parseFloat(cartonsInput.value) || 0;
        const sachets = cartons * sachetsPerCarton;
        sachetsInput.value = sachets.toFixed(4);
        kgInput.value = (sachets * kgPerSachet).toFixed(4);
      }
      recalcRow(row);
    }

    function recalcRow(row) {
      const kgInput = row.querySelector(".line-qty-kg");
      const priceInput = row.querySelector(".line-unit-price");
      const totalCell = row.querySelector(".line-total");
      const kg = parseFloat(kgInput.value) || 0;
      const price = parseFloat(priceInput.value) || 0;
      const total = kg * price;
      totalCell.textContent = formatCurrency(total);
      updateTotals();
    }

    function updateTotals() {
      const rows = salesOrderTableBody.querySelectorAll("tr");
      let total = 0;
      rows.forEach((row) => {
        const totalText = row.querySelector(".line-total")?.textContent || "";
        total += Number(totalText.replace(/[^0-9.-]+/g, "")) || 0;
      });
      if (totalPriceDisplay) totalPriceDisplay.textContent = formatCurrency(total);
      if (totalPriceDetail) totalPriceDetail.textContent = `${rows.length} product line${rows.length === 1 ? "" : "s"}`;
      if (noLinesMessage) noLinesMessage.style.display = rows.length === 0 ? "" : "none";
    }

    function addLine() {
      renderLine({ product_id: "", quantity_kg: "", quantity_sachets: "", quantity_cartons: "", unit_price: "" }, lines.length);
    }

    if (addLineButton) {
      addLineButton.addEventListener("click", addLine);
    }

    if (isSampleCheckbox) {
      isSampleCheckbox.addEventListener("change", () => {
        const isSample = isSampleCheckbox.checked;
        const rows = salesOrderTableBody.querySelectorAll("tr");
        rows.forEach((row) => {
          const priceInput = row.querySelector(".line-unit-price");
          if (isSample) {
            priceInput.dataset.originalPrice = priceInput.value;
            priceInput.value = "0.00";
            priceInput.disabled = true;
          } else {
            priceInput.disabled = false;
            const productSelect = row.querySelector(".line-product");
            const product = getProduct(productSelect.value);
            const original = priceInput.dataset.originalPrice;
            if (original) {
              priceInput.value = original;
            } else if (product) {
              priceInput.value = Number(product.selling_price).toFixed(2);
            }
          }
          recalcRow(row);
        });
      });
    }

    // Render initial lines
    salesOrderTableBody.innerHTML = "";
    if (lines.length > 0) {
      lines.forEach((line, index) => renderLine(line, index));
    } else {
      addLine();
    }

    // If sample is pre-checked, disable prices and zero them
    if (isSampleCheckbox?.checked) {
      const rows = salesOrderTableBody.querySelectorAll("tr");
      rows.forEach((row) => {
        const priceInput = row.querySelector(".line-unit-price");
        if (!priceInput.value) {
          const productSelect = row.querySelector(".line-product");
          const product = getProduct(productSelect.value);
          priceInput.dataset.originalPrice = product ? Number(product.selling_price).toFixed(2) : "";
        } else {
          priceInput.dataset.originalPrice = priceInput.value;
        }
        priceInput.value = "0.00";
        priceInput.disabled = true;
        recalcRow(row);
      });
    }
  }

  // Show/hide order details under a delivery row
  document.querySelectorAll(".toggle-details").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = document.getElementById(btn.getAttribute("aria-controls"));
      if (!row) return;
      const open = row.hidden;
      row.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Hide" : "Details";
      btn.closest("tr")?.classList.toggle("is-expanded", open);
    });
  });

  // Copy order summary to clipboard for WhatsApp
  document.querySelectorAll(".copy-whatsapp").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-order-text");
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = original), 1500);
      } catch (err) {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = original), 1500);
      }
    });
  });

  // Live carton hint on product form
  const stockKgInput = document.getElementById("stock-kg");
  const kgPerSachetInput = document.getElementById("kg-per-sachet");
  const sachetsPerCartonInput = document.getElementById("sachets-per-carton");
  const cartonHint = document.getElementById("carton-hint");

  function updateCartonHint() {
    if (!cartonHint) return;
    const stockKg = parseFloat(stockKgInput?.value || "0") || 0;
    const kgPerSachet = parseFloat(kgPerSachetInput?.value || "0") || 0;
    const sachetsPerCarton = parseFloat(sachetsPerCartonInput?.value || "0") || 0;
    if (stockKg > 0 && kgPerSachet > 0 && sachetsPerCarton > 0) {
      const sachets = stockKg / kgPerSachet;
      const cartons = sachets / sachetsPerCarton;
      cartonHint.textContent = `${stockKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg ÷ ${kgPerSachet.toLocaleString(undefined, { maximumFractionDigits: 4 })} kg/sachet ÷ ${sachetsPerCarton.toLocaleString(undefined, { maximumFractionDigits: 2 })} sachets/carton = ${cartons.toLocaleString(undefined, { maximumFractionDigits: 2 })} cartons`;
    } else {
      cartonHint.textContent = "Enter stock, kg per sachet and sachets per carton to see total cartons.";
    }
  }

  if (stockKgInput) stockKgInput.addEventListener("input", updateCartonHint);
  if (kgPerSachetInput) kgPerSachetInput.addEventListener("input", updateCartonHint);
  if (sachetsPerCartonInput) sachetsPerCartonInput.addEventListener("input", updateCartonHint);
  updateCartonHint();

  document.getElementById("install-app")?.addEventListener("click", async (e) => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    e.currentTarget.hidden = true;
  });

  // iPhone/iPad have no install prompt: show a one-time hint (logged-in pages only)
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let hintDismissed = false;
  try {
    hintDismissed = localStorage.getItem("installHintDismissed") === "1";
  } catch (err) {
    hintDismissed = true;
  }
  if (isIos && !isStandalone && sidebar && !hintDismissed) {
    const hint = document.createElement("div");
    hint.className = "install-hint";
    hint.innerHTML =
      '<span>Install this app: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</span>' +
      '<button type="button" class="install-hint-close" aria-label="Dismiss">✕</button>';
    hint.querySelector("button").addEventListener("click", () => {
      try {
        localStorage.setItem("installHintDismissed", "1");
      } catch (err) {
        // Private browsing: the hint simply shows again next time
      }
      hint.remove();
    });
    document.querySelector(".main-content")?.prepend(hint);
  }

  // Close alert messages after 4 seconds
  setTimeout(() => {
    document.querySelectorAll(".alert").forEach((alert) => {
      alert.classList.add("fade-out");
      setTimeout(() => alert.remove(), 500);
    });
  }, 4000);

  // KG Sales bar chart
  const kgSalesCanvas = document.getElementById("kg-sales-chart");
  if (kgSalesCanvas && window.kgSalesData && window.kgSalesData.labels.length > 0) {
    const { labels, data, groupBy } = window.kgSalesData;
    const ctx = kgSalesCanvas.getContext("2d");
    if (ctx && typeof Chart !== "undefined") {
      const xTitle = groupBy === "day" ? "Day" : groupBy === "month" ? "Month" : "Year";
      // eslint-disable-next-line no-undef
      new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "KG Sold",
              data,
              backgroundColor: "rgba(79, 70, 229, 0.7)",
              borderColor: "rgba(79, 70, 229, 1)",
              borderWidth: 1,
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (context) =>
                  `${Number(context.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 4 })} kg`,
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              title: { display: true, text: "KG Sold" },
            },
            x: {
              title: { display: true, text: xTitle },
            },
          },
        },
      });
    }
  }

  // Client revenue vs margin bar chart
  const clientMarginCanvas = document.getElementById("client-margin-chart");
  if (clientMarginCanvas && window.clientMarginData && window.clientMarginData.labels.length > 0) {
    const { labels, revenue, margin } = window.clientMarginData;
    const ctx = clientMarginCanvas.getContext("2d");
    if (ctx && typeof Chart !== "undefined") {
      // eslint-disable-next-line no-undef
      new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Revenue",
              data: revenue,
              backgroundColor: "rgba(79, 70, 229, 0.7)",
              borderColor: "rgba(79, 70, 229, 1)",
              borderWidth: 1,
              borderRadius: 6,
            },
            {
              label: "Margin",
              data: margin,
              backgroundColor: "rgba(16, 185, 129, 0.7)",
              borderColor: "rgba(16, 185, 129, 1)",
              borderWidth: 1,
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: "top" },
            tooltip: {
              callbacks: {
                label: (context) =>
                  `${context.dataset.label}: Rs ${Number(context.parsed.y).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              title: { display: true, text: "Amount (Rs)" },
            },
            x: {
              title: { display: true, text: "Client" },
            },
          },
        },
      });
    }
  }
});
