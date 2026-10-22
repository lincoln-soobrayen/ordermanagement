(function () {
  const root = document.getElementById("pos-app");
  if (!root) return;

  const clientIdInput = document.getElementById("pos-client");
  const clientSearch = document.getElementById("pos-client-search");
  const clientList = document.getElementById("pos-client-list");
  const clientClear = document.getElementById("pos-client-clear");
  const clientCombo = document.getElementById("pos-client-combo");
  const grid = document.getElementById("pos-grid");
  const searchInput = document.getElementById("pos-search");

  const clientSelect = {
    get value() {
      return clientIdInput?.value || "";
    },
    set value(v) {
      if (clientIdInput) clientIdInput.value = v ? String(v) : "";
    },
    focus() {
      clientSearch?.focus();
    },
  };
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
  const subtitleEl = document.getElementById("pos-subtitle");
  const addressEl = document.getElementById("pos-address");
  const notesEl = document.getElementById("pos-notes");
  const deliverLaterEl = document.getElementById("pos-deliver-later");
  const deliveryDateEl = document.getElementById("pos-delivery-date");
  const deliveryDateWrap = document.getElementById("pos-delivery-date-wrap");
  const dateHintEl = document.getElementById("pos-date-hint");
  const savePricesWrap = document.getElementById("pos-save-prices");
  const savePricesCheck = document.getElementById("pos-save-client-prices");
  const newClientForm = document.getElementById("pos-new-client");
  const newClientModal = document.getElementById("pos-new-client-modal");
  const newClientBtn = document.getElementById("pos-new-client-btn");
  const newClientCancel = document.getElementById("pos-new-client-cancel");
  const newClientCancelBtn = document.getElementById("pos-new-client-cancel-btn");
  const newClientBackdrop = document.getElementById("pos-new-client-backdrop");
  const toastEl = document.getElementById("pos-toast");
  const receiptModal = document.getElementById("pos-receipt-modal");
  const receiptMsg = document.getElementById("pos-receipt-msg");
  const receiptWhatsappBtn = document.getElementById("pos-receipt-whatsapp");
  const receiptDownload = document.getElementById("pos-receipt-download");
  const receiptDone = document.getElementById("pos-receipt-done");
  const receiptClose = document.getElementById("pos-receipt-close");
  const receiptBackdrop = document.getElementById("pos-receipt-backdrop");

  /** @type {{ id: number, receipt_url: string, whatsapp_text: string, whatsapp_phone: string|null } | null} */
  let lastReceipt = null;

  let clients = [];
  let products = [];
  /** @type {{ product_id: number, quantity_kg: number, quantity_sachets: number, quantity_cartons: number, unit_price: number }[]} */
  let cart = [];
  let toastTimer = 0;
  let cartOpen = false;

  function money(n) {
    return "Rs " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function todayIsoLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function tomorrowIsoLocal() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function syncDeliveryDateUi() {
    const later = Boolean(deliverLaterEl?.checked);
    if (deliveryDateWrap) deliveryDateWrap.hidden = !later;
    if (dateHintEl) dateHintEl.hidden = later;
    if (deliveryDateEl) {
      const minLater = tomorrowIsoLocal();
      deliveryDateEl.min = minLater;
      if (later) {
        if (!deliveryDateEl.value || deliveryDateEl.value <= todayIsoLocal()) {
          deliveryDateEl.value = minLater;
        }
      }
    }
  }

  function selectedDeliveryDate() {
    if (deliverLaterEl?.checked && deliveryDateEl?.value) {
      return deliveryDateEl.value;
    }
    return todayIsoLocal();
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

  function selectedClient() {
    return clients.find((c) => String(c.id) === String(clientSelect.value));
  }

  function updateBanner() {
    if (!subtitleEl) return;
    if (!clientSelect.value) {
      subtitleEl.textContent = "Pick a client, then add products";
      subtitleEl.classList.remove("has-client");
    } else {
      subtitleEl.textContent = `Selling to ${selectedClient()?.label || "client"}`;
      subtitleEl.classList.add("has-client");
    }
  }

  function setCartOpen(open) {
    cartOpen = open;
    root.classList.toggle("cart-open", open);
    if (cartBackdrop) cartBackdrop.hidden = !open;
    if (cartEl) cartEl.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.classList.toggle("pos-cart-open", open && window.matchMedia("(max-width: 900px)").matches);
  }

  function clientMatches(client, q) {
    if (!q) return true;
    const hay = [client.label, client.name, client.company, client.phone]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return q.split(/\s+/).every((part) => hay.includes(part));
  }

  function renderClientList(query) {
    if (!clientList) return;
    const q = (query || "").trim().toLowerCase();
    const list = clients.filter((c) => clientMatches(c, q)).slice(0, 80);
    if (!list.length) {
      clientList.innerHTML = `<li class="pos-client-empty">No clients match “${escapeHtml(query || "")}”</li>`;
      return;
    }
    clientList.innerHTML = list
      .map((c) => {
        const selected = String(c.id) === String(clientSelect.value);
        const meta = [c.phone, c.company && c.company !== c.name ? c.name : ""]
          .filter(Boolean)
          .join(" · ");
        return `<li role="option" class="pos-client-option${selected ? " is-selected" : ""}" data-id="${c.id}" aria-selected="${selected ? "true" : "false"}">
          <strong>${escapeHtml(c.label)}</strong>
          ${meta ? `<span class="muted">${escapeHtml(meta)}</span>` : ""}
        </li>`;
      })
      .join("");
  }

  function openClientList() {
    if (!clientList || !clientSearch) return;
    const selected = selectedClient();
    const q = selected && clientSearch.value === selected.label ? "" : clientSearch.value;
    renderClientList(q);
    clientList.hidden = false;
    clientSearch.setAttribute("aria-expanded", "true");
    clientCombo?.classList.add("is-open");
  }

  function closeClientList() {
    if (!clientList || !clientSearch) return;
    clientList.hidden = true;
    clientSearch.setAttribute("aria-expanded", "false");
    clientCombo?.classList.remove("is-open");
    const selected = selectedClient();
    if (selected) clientSearch.value = selected.label;
  }

  async function onClientChosen(id) {
    const prev = clientSelect.value;
    clientSelect.value = id ? String(id) : "";
    const selected = selectedClient();
    if (clientSearch) clientSearch.value = selected ? selected.label : "";
    if (clientClear) clientClear.hidden = !clientSelect.value;
    if (savePricesWrap) savePricesWrap.hidden = !clientSelect.value;
    closeClientList();
    updateBanner();
    if (selected?.delivery_location && addressEl && !addressEl.value) {
      addressEl.value = selected.delivery_location;
    }
    if (String(prev) === String(clientSelect.value)) {
      renderCart();
      return;
    }
    try {
      await loadData();
    } catch (err) {
      showError(err.message || "Failed to load prices");
    }
    renderCart();
  }

  function fillClients(selectedId) {
    if (selectedId != null && selectedId !== "") {
      clientSelect.value = String(selectedId);
    }
    const selected = selectedClient();
    const listOpen = clientList && !clientList.hidden;
    if (clientSearch && !listOpen) {
      clientSearch.value = selected ? selected.label : "";
    }
    if (clientClear) clientClear.hidden = !clientSelect.value;
    if (savePricesWrap) savePricesWrap.hidden = !clientSelect.value;
    updateBanner();
    if (listOpen) openClientList();
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
        const qtyLabel = qty ? (qty % 1 ? qty.toFixed(1) : String(qty)) : "";
        return `<button type="button" class="pos-card${qty ? " in-cart" : ""}" data-product-id="${p.id}">
          <span class="pos-card-img">${img}</span>
          <span class="pos-card-body">
            <span class="pos-card-name">${escapeHtml(p.name)}</span>
            <span class="pos-card-meta">
              <span class="pos-card-price">${money(price)}<span class="pos-card-unit">/kg</span></span>
              ${isClient ? '<span class="pos-card-tag">Client price</span>' : ""}
              ${qty ? `<span class="pos-card-badge">${qtyLabel} in cart</span>` : ""}
            </span>
          </span>
          <span class="pos-card-add" aria-hidden="true">${qty ? "+" : "Add"}</span>
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

  clientSearch?.addEventListener("focus", () => {
    if (clientSelect.value && clientSearch.value === selectedClient()?.label) {
      clientSearch.select();
    }
    openClientList();
  });
  clientSearch?.addEventListener("input", () => {
    // Typing clears the committed selection until they pick again
    if (clientSelect.value) {
      const selected = selectedClient();
      if (selected && clientSearch.value !== selected.label) {
        clientSelect.value = "";
        if (clientClear) clientClear.hidden = true;
        if (savePricesWrap) savePricesWrap.hidden = true;
        updateBanner();
        renderCart();
      }
    }
    openClientList();
  });
  clientSearch?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeClientList();
      clientSearch.blur();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Enter") {
      const first = clientList?.querySelector(".pos-client-option");
      if (e.key === "Enter" && first) {
        e.preventDefault();
        onClientChosen(first.getAttribute("data-id"));
      } else if (e.key === "ArrowDown" && first) {
        e.preventDefault();
        first.focus?.();
        openClientList();
      }
    }
  });
  clientList?.addEventListener("mousedown", (e) => {
    // Prevent input blur before click registers
    e.preventDefault();
  });
  clientList?.addEventListener("click", (e) => {
    const opt = e.target.closest(".pos-client-option");
    if (!opt) return;
    onClientChosen(opt.getAttribute("data-id"));
  });
  clientClear?.addEventListener("click", () => {
    clientSelect.value = "";
    if (clientSearch) clientSearch.value = "";
    if (clientClear) clientClear.hidden = true;
    if (savePricesWrap) savePricesWrap.hidden = true;
    updateBanner();
    renderCart();
    openClientList();
    clientSearch?.focus();
  });
  document.addEventListener("click", (e) => {
    if (!clientCombo?.contains(e.target)) closeClientList();
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

  function openNewClientModal() {
    if (!newClientModal) return;
    newClientModal.hidden = false;
    document.body.classList.add("pos-modal-open");
    window.setTimeout(() => newClientForm?.querySelector("input[name=name]")?.focus(), 30);
  }

  function closeNewClientModal() {
    if (!newClientModal) return;
    newClientModal.hidden = true;
    document.body.classList.remove("pos-modal-open");
    newClientForm?.reset();
  }

  newClientBtn?.addEventListener("click", openNewClientModal);
  newClientCancel?.addEventListener("click", closeNewClientModal);
  newClientCancelBtn?.addEventListener("click", closeNewClientModal);
  newClientBackdrop?.addEventListener("click", closeNewClientModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && newClientModal && !newClientModal.hidden) closeNewClientModal();
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
    const submitBtn = newClientForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
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
      closeNewClientModal();
      if (savePricesWrap) savePricesWrap.hidden = false;
      showToast(`Client ${data.label} ready`);
      await loadData();
    } catch (err) {
      showError(err.message || "Could not create client");
      showToast(err.message || "Could not create client");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  dockOpen?.addEventListener("click", () => setCartOpen(true));
  cartClose?.addEventListener("click", () => setCartOpen(false));
  cartBackdrop?.addEventListener("click", () => setCartOpen(false));

  deliverLaterEl?.addEventListener("change", syncDeliveryDateUi);
  syncDeliveryDateUi();

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
    if (deliverLaterEl?.checked) {
      const d = deliveryDateEl?.value || "";
      if (!d || d <= todayIsoLocal()) {
        showError("Pick a future delivery date");
        deliveryDateEl?.focus();
        setCartOpen(true);
        return;
      }
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
          delivery_date: selectedDeliveryDate(),
          notes: notesEl?.value || "",
          save_client_prices: Boolean(savePricesCheck?.checked),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      lastReceipt = {
        id: data.id,
        receipt_url: data.receipt_url || `/pos/orders/${data.id}/receipt.pdf`,
        whatsapp_text: data.whatsapp_text || `Order #${data.id}`,
        whatsapp_phone: data.whatsapp_phone || null,
      };
      resetAfterSale();
      openReceiptModal(lastReceipt);
    } catch (err) {
      showError(err.message || "Checkout failed");
      checkoutBtn.disabled = false;
      checkoutBtn.textContent = prevLabel || "Create order";
    }
  });

  function resetAfterSale() {
    cart = [];
    if (addressEl) addressEl.value = "";
    if (notesEl) notesEl.value = "";
    if (deliverLaterEl) deliverLaterEl.checked = false;
    if (savePricesCheck) savePricesCheck.checked = false;
    syncDeliveryDateUi();
    setCartOpen(false);
    renderCart();
    renderGrid();
  }

  function openReceiptModal(info) {
    if (!receiptModal) return;
    if (receiptMsg) {
      receiptMsg.textContent = `Order #${info.id} created. Receipt PDF is ready to send.`;
    }
    if (receiptDownload) {
      receiptDownload.href = info.receipt_url;
      receiptDownload.setAttribute("download", `receipt-${info.id}.pdf`);
    }
    receiptModal.hidden = false;
    document.body.classList.add("pos-modal-open");
  }

  function closeReceiptModal() {
    if (!receiptModal) return;
    receiptModal.hidden = true;
    document.body.classList.remove("pos-modal-open");
  }

  async function fetchReceiptFile(info) {
    const res = await fetch(info.receipt_url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Could not load receipt PDF");
    const blob = await res.blob();
    return new File([blob], `receipt-${info.id}.pdf`, { type: "application/pdf" });
  }

  function downloadReceiptFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function openWhatsAppText(info) {
    const text = encodeURIComponent(info.whatsapp_text || "");
    const phone = info.whatsapp_phone;
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  receiptWhatsappBtn?.addEventListener("click", async () => {
    if (!lastReceipt) return;
    receiptWhatsappBtn.disabled = true;
    const label = receiptWhatsappBtn.textContent;
    receiptWhatsappBtn.textContent = "Preparing…";
    try {
      const file = await fetchReceiptFile(lastReceipt);
      const shareData = {
        files: [file],
        title: `Order #${lastReceipt.id}`,
        text: lastReceipt.whatsapp_text,
      };
      if (navigator.canShare && navigator.canShare(shareData)) {
        await navigator.share(shareData);
        showToast("Pick WhatsApp to send the PDF");
      } else {
        downloadReceiptFile(file);
        openWhatsAppText(lastReceipt);
        showToast("PDF downloaded — attach it in WhatsApp");
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      try {
        openWhatsAppText(lastReceipt);
        showToast("WhatsApp opened with order text");
      } catch (_) {
        showError(err.message || "Could not share receipt");
      }
    } finally {
      receiptWhatsappBtn.disabled = false;
      receiptWhatsappBtn.textContent = label || "Send on WhatsApp";
    }
  });

  receiptDone?.addEventListener("click", () => {
    closeReceiptModal();
    showToast("Ready for next sale");
  });
  receiptClose?.addEventListener("click", closeReceiptModal);
  receiptBackdrop?.addEventListener("click", closeReceiptModal);

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 901px)").matches) {
      document.body.classList.remove("pos-cart-open");
      if (cartBackdrop) cartBackdrop.hidden = true;
    }
  });

  loadData().catch((err) => showError(err.message || "Could not load POS"));
})();
