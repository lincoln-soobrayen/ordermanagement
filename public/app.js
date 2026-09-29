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
