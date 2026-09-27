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

  // When creating/editing an order, selecting a lead or product navigates to a prefilled form
  const leadSelect = document.getElementById("lead-select");
  const productSelect = document.getElementById("product-select");
  const path = window.location.pathname;
  const isNewOrder = path === "/orders/new";

  function rebuildOrderUrl(changed) {
    const params = new URLSearchParams(window.location.search);
    if (changed === "lead") {
      const leadOption = leadSelect.options[leadSelect.selectedIndex];
      const leadId = leadSelect.value;
      const leadUrl = leadOption?.dataset?.url;
      if (isNewOrder && leadUrl) return leadUrl;
      if (leadId) params.set("lead_id", leadId);
      else params.delete("lead_id");
    }
    if (changed === "product") {
      const productOption = productSelect.options[productSelect.selectedIndex];
      const productId = productSelect.value;
      if (productId) params.set("product_id", productId);
      else params.delete("product_id");
      if (isNewOrder && productId && productOption) {
        return `/orders/new?${params.toString()}`;
      }
    }
    return `/orders/new?${params.toString()}`;
  }

  if (leadSelect) {
    leadSelect.addEventListener("change", () => {
      if (isNewOrder) {
        window.location.href = rebuildOrderUrl("lead");
      }
    });
  }

  const quantityKgInput = document.getElementById("quantity-kg");
  const quantitySachetsInput = document.getElementById("quantity-sachets");
  const quantityCartonsInput = document.getElementById("quantity-cartons");
  const orderValueInput = document.getElementById("order-value");
  const totalPriceDisplay = document.getElementById("total-price-display");
  const totalPriceDetail = document.getElementById("total-price-detail");
  const quantityModeSelect = document.getElementById("quantity-mode");
  const quantityRow = document.getElementById("quantity-row");

  function readProductPackaging() {
    const productOption = productSelect?.options[productSelect.selectedIndex];
    const kgPerSachet = parseFloat(productOption?.dataset?.kgPerSachet || "1") || 1;
    const sachetsPerCarton = parseFloat(productOption?.dataset?.sachetsPerCarton || "1") || 1;
    return { kgPerSachet: Math.max(kgPerSachet, 0.0001), sachetsPerCarton: Math.max(sachetsPerCarton, 0.0001) };
  }

  function selectedProductName() {
    const productOption = productSelect?.options[productSelect.selectedIndex];
    return productOption?.dataset?.name || "";
  }

  function formatCurrency(n) {
    return "Rs " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function updateOrderValue() {
    if (!orderValueInput || !productSelect) return;
    const productOption = productSelect.options[productSelect.selectedIndex];
    const price = parseFloat(productOption?.dataset?.sellingPrice || "0") || 0;
    const kg = parseFloat(quantityKgInput?.value || "0") || 0;
    const total = price * kg;
    orderValueInput.value = total.toFixed(2);
    if (totalPriceDisplay) totalPriceDisplay.textContent = formatCurrency(total);
    if (totalPriceDetail) {
      const name = selectedProductName();
      if (productOption?.value && kg > 0) {
        totalPriceDetail.textContent = `${formatCurrency(price)}/kg × ${kg.toFixed(4)} kg${name ? ` (${name})` : ""}`;
      } else if (productOption?.value) {
        totalPriceDetail.textContent = name ? `${name} — ${formatCurrency(price)}/kg` : `${formatCurrency(price)}/kg`;
      } else {
        totalPriceDetail.textContent = "Select a product and quantity";
      }
    }
  }

  function syncQuantities(source) {
    const { kgPerSachet, sachetsPerCarton } = readProductPackaging();
    if (source === "kg" && quantityKgInput) {
      const kg = parseFloat(quantityKgInput.value) || 0;
      const sachets = kg / kgPerSachet;
      if (quantitySachetsInput) quantitySachetsInput.value = sachets.toFixed(4);
      if (quantityCartonsInput) quantityCartonsInput.value = (sachets / sachetsPerCarton).toFixed(4);
    }
    if (source === "sachets" && quantitySachetsInput) {
      const sachets = parseFloat(quantitySachetsInput.value) || 0;
      if (quantityKgInput) quantityKgInput.value = (sachets * kgPerSachet).toFixed(4);
      if (quantityCartonsInput) quantityCartonsInput.value = (sachets / sachetsPerCarton).toFixed(4);
    }
    if (source === "cartons" && quantityCartonsInput) {
      const cartons = parseFloat(quantityCartonsInput.value) || 0;
      const sachets = cartons * sachetsPerCarton;
      if (quantitySachetsInput) quantitySachetsInput.value = sachets.toFixed(4);
      if (quantityKgInput) quantityKgInput.value = (sachets * kgPerSachet).toFixed(4);
    }
    updateOrderValue();
  }

  function applyQuantityMode() {
    if (!quantityModeSelect || !quantityRow) return;
    const mode = quantityModeSelect.value;
    quantityRow.classList.remove("mode-sachets", "mode-cartons", "mode-both");
    quantityRow.classList.add(`mode-${mode}`);
    if (quantitySachetsInput) {
      const sachetLabel = quantitySachetsInput.closest("label");
      if (sachetLabel) sachetLabel.style.display = mode === "cartons" ? "none" : "";
    }
    if (quantityCartonsInput) {
      const cartonLabel = quantityCartonsInput.closest("label");
      if (cartonLabel) cartonLabel.style.display = mode === "sachets" ? "none" : "";
    }
  }

  if (quantityModeSelect) {
    quantityModeSelect.addEventListener("change", () => {
      applyQuantityMode();
      if (quantitySachetsInput && quantitySachetsInput.value) syncQuantities("sachets");
      else if (quantityCartonsInput && quantityCartonsInput.value) syncQuantities("cartons");
      else if (quantityKgInput && quantityKgInput.value) syncQuantities("kg");
    });
    applyQuantityMode();
  }

  if (quantityKgInput) {
    quantityKgInput.addEventListener("input", () => syncQuantities("kg"));
  }
  if (quantitySachetsInput) {
    quantitySachetsInput.addEventListener("input", () => syncQuantities("sachets"));
  }
  if (quantityCartonsInput) {
    quantityCartonsInput.addEventListener("input", () => syncQuantities("cartons"));
  }

  if (productSelect) {
    productSelect.addEventListener("change", () => {
      const productOption = productSelect.options[productSelect.selectedIndex];
      if (isNewOrder) {
        const url = rebuildOrderUrl("product");
        if (url) window.location.href = url;
        return;
      }
      const notesInput = document.getElementById("order-notes");
      if (productOption && productOption.value) {
        syncQuantities("kg");
      }
      if (productOption && notesInput && productOption.value) {
        const productName = productOption.dataset.name;
        const existing = notesInput.value;
        const productLine = `Product: ${productName}`;
        if (!existing.includes(productLine)) {
          notesInput.value = existing ? `${existing}\n${productLine}` : productLine;
        }
      }
    });
  }

  // Initialise total if values already present
  updateOrderValue();

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
});
