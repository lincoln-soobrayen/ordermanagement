(function () {
  const root = document.getElementById("pos-app");
  if (!root) return;

  const clientSelect = document.getElementById("pos-client");
  const grid = document.getElementById("pos-grid");
  const searchInput = document.getElementById("pos-search");
  const cartEl = document.getElementById("pos-cart");
  const cartBackdrop = document.getElementById("pos-cart-backdrop");
  const cartLinesEl = document.getElementById("pos-cart-lines");
  const cartEmpty = document.getElementById("pos-cart-empty");
  const cartCount = document.getElementById("pos-cart-count");
  const cartSummary = document.getElementById("pos-cart-summary");
  const cartTotal = document.getElementById("pos-cart-total");
  const dockTotal = document.getElementById("pos-dock-total");
  const dock = document.getElementById("pos-dock");
  const dockOpen = document.getElementById("pos-dock-open");
  const cartClose = document.getElementById("pos-cart-close");
  const checkoutBtn = document.getElementById("pos-checkout");
  const errorEl = document.getElementById("pos-error");
  const bannerEl = document.getElementById("pos-banner");
  const subtitleEl = document.getElementById("pos-subtitle");
  const addressEl = document.getElementById("pos-address");
  const notesEl = document.getElementById("pos-notes");
  const savePricesWrap = document.getElementById("pos-save-prices");
  const savePricesCheck = document.getElementById("pos-save-client-prices");
  const newClientForm = document.getElementById("pos-new-client");
  const newClientBtn = document.getElementById("pos-new-client-btn");
  const newClientCancel = document.getElementById("pos-new-client-cancel");
  const toastEl = document.getElementById("pos-toast");

  let clients = [];
  let products = [];
  /** @type {{ product_id: number, quantity_kg: number, quantity_sachets: number, quantity_cartons: number, unit_price: number }[]} */
  let cart = [];
  let toastTimer = 0;
  let cartOpen = false;

  function money(n) {
    return "Rs " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("is-visible");
      toastEl.hidden = true;
    }, 1400);
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

  function cartQtyFor(productId) {
    const line = cart.find((l) => String(l.product_id) === String(productId));
    return line ? line.quantity_cartons || 0 : 0;
  }

  function cartTotals() {
    let total = 0;
    let units = 0;
    for (const line of cart) {
      total += (line.quantity_kg || 0) * (line.unit_price || 0);
      units += line.quantity_cartons || 0;
    }
    return { total, units, lines: cart.length };
  }

  function updateBanner() {
    if (!bannerEl || !subtitleEl) return;
    if (!clientSelect?.value) {
      bannerEl.hidden = false;
      bannerEl.textContent = "Choose a client first, then tap products to add them.";
      bannerEl.className = "pos-banner is-warn";
      subtitleEl.textContent = "1. Choose a client · 2. Tap products · 3. Create order";
    } else {
      const label = clientSelect.options[clientSelect.selectedIndex]?.text || "Client";
      bannerEl.hidden = true;
      subtitleEl.textContent = `Selling to ${label}`;
    }
  }

  function setCartOpen(open) {
    cartOpen = open;
    root.classList.toggle("cart-open", open);
    if (cartBackdrop) cartBackdrop.hidden = !open;
    if (cartEl) cartEl.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.classList.toggle("pos-cart-open", open && window.matchMedia("(max-width: 900px)").matches);
  }

  function fillClients(selectedId) {
    if (!clientSelect) return;
    const current = selectedId != null ? String(selectedId) : clientSelect.value;
    clientSelect.innerHTML =
      '<option value="">Choose a client…</option>' +
      clients
        .map(
          (c) =>
            `<option value="${c.id}"${String(c.id) === current ? " selected" : ""}>${escapeHtml(c.label)}</option>`
        )
        .join("");
    if (savePricesWrap) savePricesWrap.hidden = !clientSelect.value;
    updateBanner();
  }

  function renderGrid() {
    if (!grid) return;
    const q = (searchInput?.value || "").trim().toLowerCase();
    const list = products.filter((p) => {
      if (!q) return true;
      return (p.name || "").toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q);
    });
    if (!list.length) {
      grid.innerHTML = '<div class="pos-empty-state"><p>No products match your search.</p></div>';
      return;
    }
    grid.innerHTML = list
      .map((p) => {
        const price = defaultPrice(p);
        const isClient = p.client_price != null;
        const qty = cartQtyFor(p.id);
        const img = p.image_url
          ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy">`
          : `<span class="pos-card-placeholder">${escapeHtml((p.name || "?").charAt(0).toUpperCase())}</span>`;
        return `<button type="button" class="pos-card${qty ? " in-cart" : ""}" data-product-id="${p.id}">
          <span class="pos-card-img">${img}${qty ? `<span class="pos-card-badge">${qty % 1 ? qty.toFixed(1) : qty}</span>` : ""}</span>
          <span class="pos-card-body">
            <span class="pos-card-name">${escapeHtml(p.name)}</span>
            <span class="pos-card-price">${money(price)}<span class="pos-card-unit">/kg</span>${
              isClient ? '<span class="pos-card-tag">Client price</span>' : ""
            }</span>
          </span>
          <span class="pos-card-add" aria-hidden="true">+</span>
        </button>`;
      })
      .join("");
  }

  function renderCart() {
    if (!cartLinesEl || !cartEmpty || !cartCount || !cartTotal || !checkoutBtn) return;
    const { total, units, lines } = cartTotals();
    cartCount.textContent = String(lines);
    if (dockTotal) dockTotal.textContent = money(total);
    cartTotal.textContent = money(total);
    if (dock) dock.hidden = lines === 0;
    if (cartSummary) {
      cartSummary.textContent = lines
        ? `${lines} product${lines === 1 ? "" : "s"} · ${Number(units).toLocaleString(undefined, { maximumFractionDigits: 1 })} carton${units === 1 ? "" : "s"}`
        : "Empty";
    }

    const canCheckout = lines > 0 && Boolean(clientSelect?.value);
    checkoutBtn.disabled = !canCheckout;
    checkoutBtn.textContent = !clientSelect?.value
      ? "Choose a client to continue"
      : lines
        ? `Create order · ${money(total)}`
        : "Create order";

    if (!lines) {
      cartEmpty.hidden = false;
      cartLinesEl.innerHTML = "";
      renderGrid();
      return;
    }
    cartEmpty.hidden = true;
    cartLinesEl.innerHTML = cart
      .map((line, index) => {
        const product = getProduct(line.product_id);
        const name = product?.name || `Product #${line.product_id}`;
        const lineTotal = (line.quantity_kg || 0) * (line.unit_price || 0);
        const cartons = Number(line.quantity_cartons || 0);
        const thumb = product?.image_url
          ? `<img src="${escapeHtml(product.image_url)}" alt="">`
          : `<span>${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
        return `<li class="pos-cart-line" data-index="${index}">
          <div class="pos-cart-line-main">
            <span class="pos-cart-thumb">${thumb}</span>
            <div class="pos-cart-line-info">
              <strong>${escapeHtml(name)}</strong>
              <span class="muted">${money(line.unit_price)}/kg · ${money(lineTotal)}</span>
            </div>
            <div class="pos-stepper">
              <button type="button" class="pos-step" data-action="dec" data-index="${index}" aria-label="Fewer cartons">−</button>
              <span class="pos-step-value">${cartons % 1 ? cartons.toFixed(2) : cartons}</span>
              <button type="button" class="pos-step" data-action="inc" data-index="${index}" aria-label="More cartons">+</button>
            </div>
            <button type="button" class="pos-remove" data-index="${index}" aria-label="Remove">×</button>
          </div>
          <details class="pos-line-details">
            <summary>Edit kg, sachets or price</summary>
            <div class="pos-cart-qty">
              <label>Kg<input type="number" step="0.0001" inputmode="decimal" data-field="quantity_kg" data-index="${index}" value="${Number(line.quantity_kg || 0).toFixed(4)}"></label>
              <label>Sachets<input type="number" step="0.0001" inputmode="decimal" data-field="quantity_sachets" data-index="${index}" value="${Number(line.quantity_sachets || 0).toFixed(4)}"></label>
              <label>Cartons<input type="number" step="0.0001" inputmode="decimal" data-field="quantity_cartons" data-index="${index}" value="${cartons.toFixed(4)}"></label>
              <label>Rs/kg<input type="number" step="0.01" inputmode="decimal" data-field="unit_price" data-index="${index}" value="${Number(line.unit_price || 0).toFixed(2)}"></label>
            </div>
          </details>
        </li>`;
      })
      .join("");
    renderGrid();
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
    showToast(`Added ${product.name}`);
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
    updateBanner();
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
    const step = e.target.closest(".pos-step");
    if (step) {
      const index = parseInt(step.dataset.index, 10);
      const line = cart[index];
      const product = getProduct(line?.product_id);
      if (!line || !product) return;
      const delta = step.dataset.action === "inc" ? 1 : -1;
      const next = Math.max(0, (line.quantity_cartons || 0) + delta);
      if (next <= 0) {
        cart.splice(index, 1);
      } else {
        line.quantity_cartons = next;
        syncQty(line, product, "cartons");
      }
      renderCart();
      return;
    }
    const btn = e.target.closest(".pos-remove");
    if (!btn) return;
    const index = parseInt(btn.dataset.index, 10);
    cart.splice(index, 1);
    renderCart();
  });

  newClientBtn?.addEventListener("click", () => {
    if (newClientForm) {
      newClientForm.hidden = false;
      newClientForm.querySelector("input[name=name]")?.focus();
    }
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
      showToast(`Client ${data.label} ready`);
      await loadData();
    } catch (err) {
      showError(err.message || "Could not create client");
    }
  });

  dockOpen?.addEventListener("click", () => setCartOpen(true));
  cartClose?.addEventListener("click", () => setCartOpen(false));
  cartBackdrop?.addEventListener("click", () => setCartOpen(false));

  checkoutBtn?.addEventListener("click", async () => {
    showError("");
    if (!clientSelect?.value) {
      showError("Select a client first");
      clientSelect?.focus();
      setCartOpen(true);
      return;
    }
    if (!cart.length) {
      showError("Add at least one product");
      return;
    }
    checkoutBtn.disabled = true;
    const prevLabel = checkoutBtn.textContent;
    checkoutBtn.textContent = "Creating order…";
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
      checkoutBtn.textContent = prevLabel || "Create order";
    }
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 901px)").matches) {
      document.body.classList.remove("pos-cart-open");
      if (cartBackdrop) cartBackdrop.hidden = true;
    }
  });

  loadData().catch((err) => showError(err.message || "Could not load POS"));
})();
