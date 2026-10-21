(function () {
  const root = document.getElementById("pos-app");
  if (!root) return;

  const clientSelect = document.getElementById("pos-client");
  const grid = document.getElementById("pos-grid");
  const searchInput = document.getElementById("pos-search");
  const cartLinesEl = document.getElementById("pos-cart-lines");
  const cartEmpty = document.getElementById("pos-cart-empty");
  const cartCount = document.getElementById("pos-cart-count");
  const cartTotal = document.getElementById("pos-cart-total");
  const checkoutBtn = document.getElementById("pos-checkout");
  const errorEl = document.getElementById("pos-error");
  const addressEl = document.getElementById("pos-address");
  const notesEl = document.getElementById("pos-notes");
  const savePricesWrap = document.getElementById("pos-save-prices");
  const savePricesCheck = document.getElementById("pos-save-client-prices");
  const newClientForm = document.getElementById("pos-new-client");
  const newClientBtn = document.getElementById("pos-new-client-btn");
  const newClientCancel = document.getElementById("pos-new-client-cancel");
  const cartToggle = document.getElementById("pos-cart-toggle");
  const cartBody = document.getElementById("pos-cart-body");

  let clients = [];
  let products = [];
  /** @type {{ product_id: number, quantity_kg: number, quantity_sachets: number, quantity_cartons: number, unit_price: number }[]} */
  let cart = [];

  function money(n) {
    return "Rs " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function showError(msg) {
    if (!errorEl) return;
    if (!msg) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function getProduct(id) {
    return products.find((p) => String(p.id) === String(id));
  }

  function defaultPrice(product) {
    return Number(product.client_price ?? product.selling_price ?? 0);
  }

  function packaging(product) {
    return {
      kgPerSachet: Math.max(Number(product.kg_per_sachet) || 1, 0.0001),
      sachetsPerCarton: Math.max(Number(product.sachets_per_carton) || 1, 0.0001),
    };
  }

  function syncQty(line, product, source) {
    const { kgPerSachet, sachetsPerCarton } = packaging(product);
    if (source === "kg") {
      const kg = line.quantity_kg || 0;
      line.quantity_sachets = kg / kgPerSachet;
      line.quantity_cartons = line.quantity_sachets / sachetsPerCarton;
    } else if (source === "sachets") {
      const sachets = line.quantity_sachets || 0;
      line.quantity_kg = sachets * kgPerSachet;
      line.quantity_cartons = sachets / sachetsPerCarton;
    } else if (source === "cartons") {
      const cartons = line.quantity_cartons || 0;
      line.quantity_sachets = cartons * sachetsPerCarton;
      line.quantity_kg = line.quantity_sachets * kgPerSachet;
    }
  }

  function fillClients(selectedId) {
    if (!clientSelect) return;
    const current = selectedId != null ? String(selectedId) : clientSelect.value;
    clientSelect.innerHTML =
      '<option value="">Select a client…</option>' +
      clients
        .map(
          (c) =>
            `<option value="${c.id}"${String(c.id) === current ? " selected" : ""}>${escapeHtml(c.label)}</option>`
        )
        .join("");
    if (savePricesWrap) savePricesWrap.hidden = !clientSelect.value;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderGrid() {
    if (!grid) return;
    const q = (searchInput?.value || "").trim().toLowerCase();
    const list = products.filter((p) => {
      if (!q) return true;
      return (
        (p.name || "").toLowerCase().includes(q) ||
        (p.sku || "").toLowerCase().includes(q)
      );
    });
    if (!list.length) {
      grid.innerHTML = '<p class="empty">No products match.</p>';
      return;
    }
    grid.innerHTML = list
      .map((p) => {
        const price = defaultPrice(p);
        const isClient = p.client_price != null;
        const img = p.image_url
          ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy">`
          : `<span class="pos-card-placeholder">${escapeHtml((p.name || "?").charAt(0).toUpperCase())}</span>`;
        return `<button type="button" class="pos-card" data-product-id="${p.id}">
          <span class="pos-card-img">${img}</span>
          <span class="pos-card-name">${escapeHtml(p.name)}</span>
          <span class="pos-card-price">${money(price)}${isClient ? ' <span class="pos-card-tag">client</span>' : ""}</span>
        </button>`;
      })
      .join("");
  }

  function renderCart() {
    if (!cartLinesEl || !cartEmpty || !cartCount || !cartTotal || !checkoutBtn) return;
    cartCount.textContent = String(cart.length);
    if (!cart.length) {
      cartEmpty.hidden = false;
      cartLinesEl.innerHTML = "";
      cartTotal.textContent = money(0);
      checkoutBtn.disabled = true;
      return;
    }
    cartEmpty.hidden = true;
    let total = 0;
    cartLinesEl.innerHTML = cart
      .map((line, index) => {
        const product = getProduct(line.product_id);
        const name = product?.name || `Product #${line.product_id}`;
        const lineTotal = (line.quantity_kg || 0) * (line.unit_price || 0);
        total += lineTotal;
        return `<li class="pos-cart-line" data-index="${index}">
          <div class="pos-cart-line-top">
            <strong>${escapeHtml(name)}</strong>
            <button type="button" class="button small danger pos-remove" data-index="${index}" aria-label="Remove">×</button>
          </div>
          <div class="pos-cart-qty">
            <label>Kg<input type="number" step="0.0001" inputmode="decimal" data-field="quantity_kg" data-index="${index}" value="${line.quantity_kg || ""}"></label>
            <label>Sachets<input type="number" step="0.0001" inputmode="decimal" data-field="quantity_sachets" data-index="${index}" value="${Number(line.quantity_sachets || 0).toFixed(4)}"></label>
            <label>Cartons<input type="number" step="0.0001" inputmode="decimal" data-field="quantity_cartons" data-index="${index}" value="${Number(line.quantity_cartons || 0).toFixed(4)}"></label>
            <label>Rs/kg<input type="number" step="0.01" inputmode="decimal" data-field="unit_price" data-index="${index}" value="${Number(line.unit_price || 0).toFixed(2)}"></label>
          </div>
          <div class="pos-cart-line-total">${money(lineTotal)}</div>
        </li>`;
      })
      .join("");
    cartTotal.textContent = money(total);
    checkoutBtn.disabled = !clientSelect?.value;
  }

  function addProduct(productId) {
    const product = getProduct(productId);
    if (!product) return;
    const existing = cart.find((l) => String(l.product_id) === String(productId));
    if (existing) {
      existing.quantity_cartons = (existing.quantity_cartons || 0) + 1;
      syncQty(existing, product, "cartons");
    } else {
      const line = {
        product_id: product.id,
        quantity_kg: 0,
        quantity_sachets: 0,
        quantity_cartons: 1,
        unit_price: defaultPrice(product),
      };
      syncQty(line, product, "cartons");
      cart.push(line);
    }
    renderCart();
    showError("");
  }

  async function loadData() {
    const leadId = clientSelect?.value || "";
    const url = leadId ? `/pos/data?lead_id=${encodeURIComponent(leadId)}` : "/pos/data";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Could not load POS data");
    const data = await res.json();
    clients = data.clients || [];
    products = data.products || [];
    fillClients(leadId);
    // Refresh cart unit prices only for lines still at previous default? Keep typed prices.
    renderGrid();
    renderCart();
  }

  grid?.addEventListener("click", (e) => {
    const btn = e.target.closest(".pos-card");
    if (!btn) return;
    addProduct(btn.dataset.productId);
  });

  searchInput?.addEventListener("input", () => renderGrid());

  clientSelect?.addEventListener("change", async () => {
    const selected = clients.find((c) => String(c.id) === clientSelect.value);
    if (selected?.delivery_location && addressEl && !addressEl.value) {
      addressEl.value = selected.delivery_location;
    }
    if (savePricesWrap) savePricesWrap.hidden = !clientSelect.value;
    try {
      await loadData();
    } catch (err) {
      showError(err.message || "Failed to load prices");
    }
    renderCart();
  });

  cartLinesEl?.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-index]");
    if (!input) return;
    const index = parseInt(input.dataset.index, 10);
    const field = input.dataset.field;
    const line = cart[index];
    if (!line || !field) return;
    const product = getProduct(line.product_id);
    line[field] = parseFloat(input.value) || 0;
    if (product && field !== "unit_price") {
      const source = field === "quantity_kg" ? "kg" : field === "quantity_sachets" ? "sachets" : "cartons";
      syncQty(line, product, source);
    }
    renderCart();
  });

  cartLinesEl?.addEventListener("click", (e) => {
    const btn = e.target.closest(".pos-remove");
    if (!btn) return;
    const index = parseInt(btn.dataset.index, 10);
    cart.splice(index, 1);
    renderCart();
  });

  newClientBtn?.addEventListener("click", () => {
    if (newClientForm) newClientForm.hidden = false;
  });
  newClientCancel?.addEventListener("click", () => {
    if (newClientForm) {
      newClientForm.hidden = true;
      newClientForm.reset();
    }
  });

  newClientForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const form = new FormData(newClientForm);
    const body = {
      name: String(form.get("name") || "").trim(),
      company: String(form.get("company") || "").trim(),
      phone: String(form.get("phone") || "").trim(),
    };
    try {
      const res = await fetch("/pos/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create client");
      clients.push(data);
      clients.sort((a, b) => a.label.localeCompare(b.label));
      fillClients(data.id);
      newClientForm.hidden = true;
      newClientForm.reset();
      if (savePricesWrap) savePricesWrap.hidden = false;
      await loadData();
    } catch (err) {
      showError(err.message || "Could not create client");
    }
  });

  cartToggle?.addEventListener("click", () => {
    if (!cartBody || !cartToggle) return;
    const open = cartBody.hidden;
    cartBody.hidden = !open;
    cartToggle.textContent = open ? "Hide" : "Show";
    cartToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  checkoutBtn?.addEventListener("click", async () => {
    showError("");
    if (!clientSelect?.value) {
      showError("Select a client");
      return;
    }
    if (!cart.length) {
      showError("Add at least one product");
      return;
    }
    checkoutBtn.disabled = true;
    try {
      const res = await fetch("/pos/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          lead_id: clientSelect.value,
          lines: cart,
          delivery_address: addressEl?.value || "",
          notes: notesEl?.value || "",
          save_client_prices: Boolean(savePricesCheck?.checked),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      window.location.href = data.redirect || "/pos";
    } catch (err) {
      showError(err.message || "Checkout failed");
      checkoutBtn.disabled = false;
    }
  });

  loadData().catch((err) => showError(err.message || "Could not load POS"));
})();
