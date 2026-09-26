import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import path from "path";
import dotenv from "dotenv";
import { pool, initDb, Lead, Order, OrderItem, Product, User } from "./db";
import { authenticateUser } from "./auth";
import { page, escapeHtml, alertHtml, statusOptions } from "./views";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "default-secret-change-me";

declare module "express-session" {
  interface SessionData {
    user?: User;
    flash?: { message: string; type: "success" | "error" };
  }
}

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    next();
  } else {
    res.redirect("/login");
  }
}

function flash(req: Request): { message?: string; type?: "success" | "error" } {
  const data = req.session.flash || {};
  delete req.session.flash;
  return data;
}

function setFlash(
  req: Request,
  message: string,
  type: "success" | "error" = "success"
): void {
  req.session.flash = { message, type };
}

app.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  res.send(
    page(
      "Login",
      `
      <div class="login-box">
        <h1>Login</h1>
        <form method="post" action="/login">
          <label>Email<input type="email" name="email" required autofocus></label>
          <label>Password<input type="password" name="password" required></label>
          <button type="submit">Sign in</button>
          <p class="hint">Default: admin@example.com / admin123</p>
        </form>
      </div>`,
      undefined
    )
  );
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await authenticateUser(email, password);
  if (user) {
    req.session.user = user;
    res.redirect("/dashboard");
  } else {
    setFlash(req, "Invalid email or password", "error");
    res.redirect("/login");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/", requireAuth, (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", requireAuth, async (req, res) => {
  const f = flash(req);
  const leadCounts = await pool.query(
    "SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY status"
  );
  const orderCounts = await pool.query(
    "SELECT status, COUNT(*) as count FROM orders GROUP BY status ORDER BY status"
  );
  const totals = await pool.query(
    "SELECT COALESCE(SUM(value), 0) as leads_value FROM leads UNION ALL SELECT COALESCE(SUM(order_value), 0) FROM orders"
  );
  const recentLeads = await pool.query(
    "SELECT id, name, status, value FROM leads ORDER BY updated_at DESC LIMIT 5"
  );
  const recentOrders = await pool.query(
    "SELECT id, customer_name, status, order_value FROM orders ORDER BY updated_at DESC LIMIT 5"
  );

  const leadValue = totals.rows[0]?.leads_value || 0;
  const orderValue = totals.rows[1]?.leads_value || 0;

  const makeCards = (rows: { status: string; count: string }[]) =>
    rows
      .map(
        (r) =>
          `<div class="card"><span class="badge">${escapeHtml(r.count)}</span><strong>${escapeHtml(
            r.status.charAt(0).toUpperCase() + r.status.slice(1)
          )}</strong></span></div>`
      )
      .join("");

  res.send(
    page(
      "Dashboard",
      `
      ${f.message ? alertHtml(f.message, f.type) : ""}
      <h1>Dashboard</h1>
      <section class="stats">
        <div class="card highlight"><strong>Rs ${escapeHtml(Number(leadValue).toLocaleString())}</strong><span>Pipeline Value</span></div>
        <div class="card highlight"><strong>Rs ${escapeHtml(Number(orderValue).toLocaleString())}</strong><span>Order Value</span></div>
      </section>
      <section>
        <h2>Leads by Status</h2>
        <div class="cards">${makeCards(leadCounts.rows)}</div>
      </section>
      <section>
        <h2>Orders by Status</h2>
        <div class="cards">${makeCards(orderCounts.rows)}</div>
      </section>
      <section>
        <h2>Recent Leads</h2>
        <div class="table-wrap">${leadsTable(recentLeads.rows)}</div>
      </section>
      <section>
        <h2>Recent Orders</h2>
        <div class="table-wrap">${ordersTable(recentOrders.rows)}</div>
      </section>`,
      req.session.user!.name
    )
  );
});

const leadStatuses = ["new", "contacted", "qualified", "converted", "lost"];
const orderStatuses = ["order_placed", "pending", "confirmed", "shipped", "completed", "cancelled"];
const deliveryStatuses = ["not_shipped", "shipped", "in_transit", "delivered", "returned"];

type OrderWithProduct = Partial<Order> & { product_id?: number };
type OrderWithLead = Order & { lead_name?: string; product_id?: number; quantity_sachets?: number; quantity_cartons?: number; delivery_date_formatted?: string };

app.get("/leads", requireAuth, async (req, res) => {
  const { status, q } = req.query as { status?: string; q?: string };
  let where = "WHERE 1=1";
  const params: (string | undefined)[] = [];
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR company ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }

  const result = await pool.query(
    `SELECT id, name, company, email, phone, status, value FROM leads ${where} ORDER BY updated_at DESC`,
    params
  );

  res.send(
    page(
      "Leads",
      `
      <div class="page-title-row">
        <h1>Leads</h1>
        <a href="/leads/new" class="button">+ New Lead</a>
      </div>
      <div class="toolbar">
        <form method="get" class="filters">
          <input type="search" name="q" value="${escapeHtml(q || "")}" placeholder="Search leads...">
          <select name="status">
            <option value="">All statuses</option>
            ${statusOptions(status || "", leadStatuses)}
          </select>
          <button type="submit">Filter</button>
          <a href="/export/leads" class="button secondary">Export CSV</a>
        </form>
      </div>
      <div class="table-wrap">${leadsTable(result.rows, true)}</div>`,
      req.session.user!.name
    )
  );
});

app.get("/leads/new", requireAuth, (req, res) => {
  res.send(
    page(
      "New Lead",
      `
      <h1>New Lead</h1>
      <form method="post" action="/leads" class="form-grid">
        ${leadFormFields({})}
        <div class="actions">
          <button type="submit">Save Lead</button>
          <a href="/leads" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req.session.user!.name
    )
  );
});

app.post("/leads", requireAuth, async (req, res) => {
  const { name, company, email, phone, status, value, delivery_location, notes } = req.body;
  await pool.query(
    "INSERT INTO leads (name, company, email, phone, status, value, delivery_location, notes, assigned_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [name, company || null, email || null, phone || null, status || "new", parseFloat(value) || 0, delivery_location || null, notes || null, req.session.user!.id]
  );
  setFlash(req, "Lead created");
  res.redirect("/leads");
});

app.get("/leads/:id/edit", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
  const lead = result.rows[0] as Lead | undefined;
  if (!lead) {
    res.status(404).send(page("Not Found", "<h1>Lead not found</h1>", req.session.user!.name));
    return;
  }
  res.send(
    page(
      "Edit Lead",
      `
      <h1>Edit Lead</h1>
      <form method="post" action="/leads/${escapeHtml(lead.id)}/update" class="form-grid">
        ${leadFormFields(lead)}
        <div class="actions">
          <button type="submit">Update Lead</button>
          <a href="/leads" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req.session.user!.name
    )
  );
});

app.post("/leads/:id/update", requireAuth, async (req, res) => {
  const { name, company, email, phone, status, value, delivery_location, notes } = req.body;
  await pool.query(
    "UPDATE leads SET name = $1, company = $2, email = $3, phone = $4, status = $5, value = $6, delivery_location = $7, notes = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9",
    [name, company || null, email || null, phone || null, status || "new", parseFloat(value) || 0, delivery_location || null, notes || null, req.params.id]
  );
  setFlash(req, "Lead updated");
  res.redirect("/leads");
});

app.post("/leads/:id/delete", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM leads WHERE id = $1", [req.params.id]);
  setFlash(req, "Lead deleted");
  res.redirect("/leads");
});

app.get("/leads/:id/notes", requireAuth, async (req, res) => {
  const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1", [
    req.params.id,
  ]);
  const lead = leadResult.rows[0] as Lead | undefined;
  if (!lead) {
    res.status(404).send(page("Not Found", "<h1>Lead not found</h1>", req.session.user!.name));
    return;
  }

  const commentsResult = await pool.query(
    `SELECT lc.id, lc.lead_id, lc.user_id, u.name as user_name, lc.comment, lc.created_at
     FROM lead_comments lc
     LEFT JOIN users u ON lc.user_id = u.id
     WHERE lc.lead_id = $1
     ORDER BY lc.created_at DESC`,
    [req.params.id]
  );
  const comments = commentsResult.rows;
  const f = flash(req);

  const commentsHtml = comments.length
    ? `<div class="comments">
        ${comments
          .map(
            (c) => `
          <div class="comment">
            <div class="comment-meta">
              <strong>${escapeHtml(c.user_name || "Unknown")}</strong>
              <span>${escapeHtml(new Date(c.created_at).toLocaleString())}</span>
            </div>
            <div class="comment-body">${escapeHtml(c.comment).replace(/\n/g, "<br>")}</div>
            <form method="post" action="/leads/${c.lead_id}/comments/${c.id}/delete" class="inline">
              <button type="submit" class="link-button" onclick="return confirm('Delete this comment?')">Delete</button>
            </form>
          </div>`
          )
          .join("")}
       </div>`
    : `<p class="empty">No comments yet.</p>`;

  const locationHtml = lead.delivery_location
    ? `<p><strong>Delivery Location:</strong> ${escapeHtml(lead.delivery_location)}</p>`
    : "";

  res.send(
    page(
      "Lead Notes",
      `
      ${f.message ? alertHtml(f.message, f.type) : ""}
      <div class="page-title-row">
        <h1>Lead Notes: ${escapeHtml(lead.name)}</h1>
        <a href="/leads" class="button secondary">← Back to Leads</a>
      </div>
      <section class="lead-summary">
        <p><strong>Company:</strong> ${escapeHtml(lead.company) || "—"}</p>
        <p><strong>Email:</strong> ${escapeHtml(lead.email) || "—"}</p>
        <p><strong>Phone:</strong> ${escapeHtml(lead.phone) || "—"}</p>
        <p><strong>Status:</strong> <span class="status status-${escapeHtml(lead.status)}">${escapeHtml(
          lead.status.charAt(0).toUpperCase() + lead.status.slice(1)
        )}</span></p>
        <p><strong>Value:</strong> Rs ${escapeHtml(Number(lead.value || 0).toLocaleString())}</p>
        ${locationHtml}
        ${lead.notes ? `<p><strong>Notes:</strong> ${escapeHtml(lead.notes)}</p>` : ""}
      </section>
      <section>
        <h2>Comments</h2>
        ${commentsHtml}
        <form method="post" action="/leads/${lead.id}/comments" class="form-grid">
          <label class="full">Add a comment
            <textarea name="comment" rows="4" required placeholder="Write a comment..."></textarea>
          </label>
          <div class="actions">
            <button type="submit">Add Comment</button>
            <a href="/leads" class="button secondary">Back to Leads</a>
          </div>
        </form>
      </section>`,
      req.session.user!.name
    )
  );
});

app.post("/leads/:id/comments", requireAuth, async (req, res) => {
  const { comment } = req.body;
  if (!comment || !comment.trim()) {
    setFlash(req, "Comment cannot be empty", "error");
    res.redirect(`/leads/${req.params.id}/notes`);
    return;
  }
  await pool.query(
    "INSERT INTO lead_comments (lead_id, user_id, comment) VALUES ($1, $2, $3)",
    [req.params.id, req.session.user!.id, comment.trim()]
  );
  await pool.query(
    "UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    [req.params.id]
  );
  setFlash(req, "Comment added");
  res.redirect(`/leads/${req.params.id}/notes`);
});

app.post("/leads/:id/comments/:commentId/delete", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM lead_comments WHERE id = $1 AND lead_id = $2", [
    req.params.commentId,
    req.params.id,
  ]);
  setFlash(req, "Comment deleted");
  res.redirect(`/leads/${req.params.id}/notes`);
});

function leadFormFields(lead: Partial<Lead>): string {
  return `
    <label>Name *<input type="text" name="name" value="${escapeHtml(lead.name)}" required></label>
    <label>Company<input type="text" name="company" value="${escapeHtml(lead.company)}"></label>
    <label>Email<input type="email" name="email" value="${escapeHtml(lead.email)}"></label>
    <label>Phone<input type="text" name="phone" value="${escapeHtml(lead.phone)}"></label>
    <label>Status<select name="status">${statusOptions(lead.status || "", leadStatuses)}</select></label>
    <label>Estimated Value<input type="number" step="0.01" name="value" value="${escapeHtml(
      lead.value ?? ""
    )}"></label>
    <label class="full">Delivery Location / Link<textarea name="delivery_location" rows="2" placeholder="Enter address or a Google Maps / location link">${escapeHtml(lead.delivery_location)}</textarea></label>
    <label class="full">Notes<textarea name="notes" rows="4">${escapeHtml(lead.notes)}</textarea></label>
  `;
}

function leadsTable(rows: Partial<Lead>[], actions = false): string {
  if (rows.length === 0) return "<p class=\"empty\">No leads found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>Name</th><th>Company</th><th>Email</th><th>Status</th><th>Value</th>${
          actions ? "<th>Actions</th>" : ""
        }</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (l) => `
          <tr>
            <td>${escapeHtml(l.name)}</td>
            <td>${escapeHtml(l.company)}</td>
            <td>${escapeHtml(l.email)}</td>
            <td><span class="status status-${escapeHtml(l.status)}">${escapeHtml(
              l.status?.charAt(0).toUpperCase() + (l.status?.slice(1) || "")
            )}</span></td>
            <td>Rs ${escapeHtml(Number(l.value || 0).toLocaleString())}</td>
            ${
              actions
                ? `<td class="actions">
                    <a href="/leads/${l.id}/notes" class="button small">Notes</a>
                    <a href="/leads/${l.id}/edit" class="button small">Edit</a>
                    <form method="post" action="/leads/${l.id}/delete" class="inline">
                      <button type="submit" class="button small danger" onclick="return confirm('Delete this lead?')">Delete</button>
                    </form>
                  </td>`
                : ""
            }
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

app.get("/orders", requireAuth, async (req, res) => {
  const { status, q } = req.query as { status?: string; q?: string };
  let where = "WHERE 1=1";
  const params: (string | undefined)[] = [];
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (customer_name ILIKE $${params.length})`;
  }

  const result = await pool.query(
    `SELECT o.*, l.name as lead_name, oi.quantity_sachets, oi.quantity_cartons FROM orders o LEFT JOIN leads l ON o.lead_id = l.id LEFT JOIN order_items oi ON o.id = oi.order_id ${where} ORDER BY o.order_date DESC`,
    params
  );

  res.send(
    page(
      "Orders",
      `
      <div class="page-title-row">
        <h1>Orders</h1>
        <a href="/orders/new" class="button">+ New Order</a>
      </div>
      <div class="toolbar">
        <form method="get" class="filters">
          <input type="search" name="q" value="${escapeHtml(q || "")}" placeholder="Search orders...">
          <select name="status">
            <option value="">All statuses</option>
            ${statusOptions(status || "", orderStatuses)}
          </select>
          <button type="submit">Filter</button>
          <a href="/export/orders" class="button secondary">Export CSV</a>
        </form>
      </div>
      <div class="table-wrap">${ordersTable(result.rows, true)}</div>`,
      req.session.user!.name
    )
  );
});

app.get("/orders/new", requireAuth, async (req, res) => {
  const { lead_id, product_id } = req.query as { lead_id?: string; product_id?: string };
  let prefilled: Partial<Order> = {};
  let leads = await pool.query("SELECT id, name FROM leads ORDER BY name");
  let products = await pool.query("SELECT id, name, cost_price, selling_price, kg_per_sachet, sachets_per_carton FROM products ORDER BY name");
  if (lead_id) {
    const leadResult = await pool.query(
      "SELECT id, name, company, email, phone, value, delivery_location FROM leads WHERE id = $1",
      [lead_id]
    );
    const lead = leadResult.rows[0];
    if (lead) {
      prefilled = {
        lead_id: parseInt(lead_id, 10),
        customer_name: lead.company ? `${lead.name} (${lead.company})` : lead.name,
        order_value: lead.value || 0,
        delivery_address: lead.delivery_location || null,
        notes: `Lead contact: ${lead.email || lead.phone || "none"}`,
      };
    }
  }
  if (product_id) {
    const productResult = await pool.query(
      "SELECT id, name, selling_price FROM products WHERE id = $1",
      [product_id]
    );
    const product = productResult.rows[0];
    if (product) {
      (prefilled as OrderWithProduct).product_id = parseInt(product_id, 10);
      prefilled.order_value = product.selling_price || 0;
      prefilled.notes = prefilled.notes
        ? `${prefilled.notes}\nProduct: ${product.name}`
        : `Product: ${product.name}`;
    }
  }
  res.send(
    page(
      "New Order",
      `
      <h1>New Order</h1>
      <form method="post" action="/orders" class="form-grid">
        ${orderFormFields(prefilled, leads.rows, products.rows)}
        <div class="actions">
          <button type="submit">Save Order</button>
          <a href="/orders" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req.session.user!.name
    )
  );
});

app.post("/orders", requireAuth, async (req, res) => {
  const { lead_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, customer_name, delivery_status, delivery_address, delivery_date, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let finalOrderValue = 0;
    if (product_id) {
      const productResult = await client.query(
        "SELECT selling_price FROM products WHERE id = $1",
        [product_id]
      );
      const product = productResult.rows[0];
      if (product) {
        finalOrderValue = (parseFloat(quantity_kg) || 0) * (product.selling_price || 0);
      }
    }
    const orderResult = await client.query(
      "INSERT INTO orders (lead_id, customer_name, order_value, status, order_date, delivery_status, delivery_address, delivery_date, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
      [
        lead_id || null,
        customer_name,
        finalOrderValue,
        "order_placed",
        new Date().toISOString().split("T")[0],
        delivery_status || "not_shipped",
        delivery_address || null,
        delivery_date || null,
        notes || null,
      ]
    );
    if (product_id) {
      const productResult = await client.query(
        "SELECT selling_price FROM products WHERE id = $1",
        [product_id]
      );
      const product = productResult.rows[0];
      if (product) {
        await client.query(
          "INSERT INTO order_items (order_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, unit_price) VALUES ($1, $2, $3, $4, $5, $6)",
          [orderResult.rows[0].id, product_id, parseFloat(quantity_kg) || 0, parseFloat(quantity_sachets) || 0, parseFloat(quantity_cartons) || 0, product.selling_price || 0]
        );
      }
    }
    await client.query("COMMIT");
    setFlash(req, "Order created");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.redirect("/orders");
});

app.get("/orders/:id/edit", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = result.rows[0] as Order | undefined;
  if (!order) {
    res.status(404).send(page("Not Found", "<h1>Order not found</h1>", req.session.user!.name));
    return;
  }
  const leads = await pool.query("SELECT id, name FROM leads ORDER BY name");
  const products = await pool.query("SELECT id, name, cost_price, selling_price, kg_per_sachet, sachets_per_carton FROM products ORDER BY name");
  const orderItemResult = await pool.query(
    "SELECT product_id, quantity_kg, quantity_sachets, quantity_cartons FROM order_items WHERE order_id = $1 LIMIT 1",
    [req.params.id]
  );
  const orderItem = orderItemResult.rows[0];
  if (orderItem) {
    (order as any).product_id = orderItem.product_id;
    (order as any).quantity_kg = orderItem.quantity_kg;
    (order as any).quantity_sachets = orderItem.quantity_sachets;
    (order as any).quantity_cartons = orderItem.quantity_cartons;
  }
  res.send(
    page(
      "Edit Order",
      `
      <h1>Edit Order</h1>
      <form method="post" action="/orders/${escapeHtml(order.id)}/update" class="form-grid">
        ${orderFormFields(order, leads.rows, products.rows)}
        <div class="actions">
          <button type="submit">Update Order</button>
          <a href="/orders" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req.session.user!.name
    )
  );
});

app.post("/orders/:id/update", requireAuth, async (req, res) => {
  const { lead_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, customer_name, delivery_status, delivery_address, delivery_date, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let finalOrderValue = 0;
    if (product_id) {
      const productResult = await client.query(
        "SELECT selling_price FROM products WHERE id = $1",
        [product_id]
      );
      const product = productResult.rows[0];
      if (product) {
        finalOrderValue = (parseFloat(quantity_kg) || 0) * (product.selling_price || 0);
      }
    }
    await client.query(
      "UPDATE orders SET lead_id = $1, customer_name = $2, order_value = $3, delivery_status = $4, delivery_address = $5, delivery_date = $6, notes = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8",
      [
        lead_id || null,
        customer_name,
        finalOrderValue,
        delivery_status || "not_shipped",
        delivery_address || null,
        delivery_date || null,
        notes || null,
        req.params.id,
      ]
    );
    await client.query("DELETE FROM order_items WHERE order_id = $1", [req.params.id]);
    if (product_id) {
      const productResult = await client.query(
        "SELECT selling_price FROM products WHERE id = $1",
        [product_id]
      );
      const product = productResult.rows[0];
      if (product) {
        await client.query(
          "INSERT INTO order_items (order_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, unit_price) VALUES ($1, $2, $3, $4, $5, $6)",
          [req.params.id, product_id, parseFloat(quantity_kg) || 0, parseFloat(quantity_sachets) || 0, parseFloat(quantity_cartons) || 0, product.selling_price || 0]
        );
      }
    }
    await client.query("COMMIT");
    setFlash(req, "Order updated");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.redirect("/orders");
});

app.post("/orders/:id/deliver", requireAuth, async (req, res) => {
  await pool.query(
    "UPDATE orders SET delivery_status = 'delivered', status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    [req.params.id]
  );
  setFlash(req, "Order marked as delivered");
  res.redirect("/orders");
});

app.post("/orders/:id/delete", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  setFlash(req, "Order deleted");
  res.redirect("/orders");
});

function orderFormFields(
  order: OrderWithProduct,
  leads: { id: number; name: string }[],
  products: { id: number; name: string; cost_price: number; selling_price: number; kg_per_sachet: number; sachets_per_carton: number }[] = []
): string {
  const leadOptions = leads
    .map(
      (l) =>
        `<option value="${l.id}" data-url="/orders/new?lead_id=${l.id}" ${l.id === order.lead_id ? "selected" : ""}>${escapeHtml(
          l.name
        )}</option>`
    )
    .join("");
  const productOptions = products
    .map(
      (p) => {
        const urlParams = new URLSearchParams();
        if (order.lead_id) urlParams.set("lead_id", String(order.lead_id));
        urlParams.set("product_id", String(p.id));
        return `<option value="${p.id}" data-selling-price="${p.selling_price || 0}" data-kg-per-sachet="${p.kg_per_sachet || 1}" data-sachets-per-carton="${p.sachets_per_carton || 1}" data-name="${escapeHtml(p.name)}" data-url="/orders/new?${escapeHtml(
          urlParams.toString()
        )}" ${p.id === order.product_id ? "selected" : ""}>${escapeHtml(p.name)} — Rs ${Number(
          p.selling_price || 0
        ).toLocaleString()}/kg</option>`;
      }
    )
    .join("");
  const dateStr = order.order_date
    ? new Date(order.order_date).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];
  const shippedStr = "";
  const productSelect = products.length
    ? `<label>Product (optional)<select name="product_id" id="product-select"><option value="">— none —</option>${productOptions}</select></label>`
    : "<p class=\"empty\">No products yet. <a href=\"/products/new\">Add one</a>.</p>";
  const quantityKg = (order as any).quantity_kg ?? "";
  const quantitySachets = (order as any).quantity_sachets ?? "";
  const quantityCartons = (order as any).quantity_cartons ?? "";
  return `
    <label>Linked Lead<select name="lead_id" id="lead-select"><option value="">— none —</option>${leadOptions}</select></label>
    ${productSelect}
    <div class="total-price-card full">
      <div class="total-price-label">Total Price</div>
      <div class="total-price-amount" id="total-price-display">Rs 0.00</div>
      <div class="total-price-detail" id="total-price-detail">Select a product and quantity</div>
    </div>
    <div class="order-quantity-card full">
      <div class="order-quantity-header">
        <span class="order-quantity-title">Order Quantity</span>
        <select name="quantity_mode" id="quantity-mode">
          <option value="sachets">Sachets</option>
          <option value="cartons">Cartons</option>
          <option value="both">Both</option>
        </select>
      </div>
      <div class="quantity-row" id="quantity-row">
        <label class="qty-sachets">Quantity (sachets)<input type="number" step="0.0001" name="quantity_sachets" id="quantity-sachets" value="${escapeHtml(quantitySachets)}" placeholder="sachets" inputmode="decimal"></label>
        <label class="qty-cartons">Quantity (cartons)<input type="number" step="0.0001" name="quantity_cartons" id="quantity-cartons" value="${escapeHtml(quantityCartons)}" placeholder="cartons" inputmode="decimal"></label>
      </div>
      <label class="qty-kg full">Quantity (kg)<input type="number" step="0.0001" name="quantity_kg" id="quantity-kg" value="${escapeHtml(quantityKg)}" placeholder="kg" inputmode="decimal"></label>
    </div>
    <label>Customer Name *<input type="text" name="customer_name" id="customer-name" value="${escapeHtml(
      order.customer_name
    )}" required></label>
    <input type="hidden" name="order_value" id="order-value" value="${escapeHtml(order.order_value ?? "")}">
    <input type="hidden" name="status" value="order_placed">
    <input type="hidden" name="order_date" value="${escapeHtml(dateStr)}">
    <label>Delivery Status<select name="delivery_status">${statusOptions(
      order.delivery_status || "",
      deliveryStatuses
    )}</select></label>
    <label>Delivery Date &amp; Time<input type="datetime-local" name="delivery_date" id="delivery-date" value="${escapeHtml(
      order.delivery_date ? new Date(order.delivery_date).toISOString().slice(0, 16) : ""
    )}"></label>
    <label class="full">Delivery Address<textarea name="delivery_address" rows="2">${escapeHtml(
      order.delivery_address
    )}</textarea></label>
    <label class="full">Notes<textarea name="notes" id="order-notes" rows="4">${escapeHtml(order.notes)}</textarea></label>
  `;
}

function whatsappOrderText(o: OrderWithLead, date: string): string {
  const qtyParts: string[] = [];
  if (o.quantity_cartons && Number(o.quantity_cartons) > 0) {
    qtyParts.push(`${Number(o.quantity_cartons).toLocaleString(undefined, { maximumFractionDigits: 2 })} cartons`);
  }
  if (o.quantity_sachets && Number(o.quantity_sachets) > 0) {
    qtyParts.push(`${Number(o.quantity_sachets).toLocaleString(undefined, { maximumFractionDigits: 2 })} sachets`);
  }
  const qtyLine = qtyParts.length > 0 ? `Quantity: ${qtyParts.join(" / ")}` : null;

  const deliveryDateTime = o.delivery_date
    ? new Date(o.delivery_date).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const lines = [
    `*Order #${o.id}*`,
    `Customer: ${o.customer_name || "—"}`,
    o.lead_name ? `Lead: ${o.lead_name}` : null,
    `Status: ${o.status ? o.status.charAt(0).toUpperCase() + o.status.slice(1) : "—"}`,
    `Delivery: ${o.delivery_status ? o.delivery_status.replace(/_/g, " ") : "Not shipped"}`,
    `Date: ${date}`,
    deliveryDateTime ? `Delivery Date/Time: ${deliveryDateTime}` : null,
    qtyLine,
    `Value: Rs ${Number(o.order_value || 0).toLocaleString()}`,
    o.delivery_address ? `Address: ${o.delivery_address}` : null,
    o.notes ? `Notes: ${o.notes}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function ordersTable(rows: Partial<OrderWithLead>[], actions = false): string {
  if (rows.length === 0) return "<p class=\"empty\">No orders found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>Customer</th><th>Lead</th><th>Status</th><th>Date</th><th>Value</th>${
          actions ? "<th>Actions</th>" : ""
        }</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (o) => {
              const date = o.order_date
                ? new Date(o.order_date).toLocaleDateString()
                : "";
              const deliveryClass = `status-${escapeHtml(o.delivery_status || "not_shipped")}`;
              const deliveryLabel = o.delivery_status
                ? o.delivery_status.charAt(0).toUpperCase() + o.delivery_status.slice(1).replace(/_/g, " ")
                : "Not shipped";
              const canDeliver = (o.delivery_status || "not_shipped") !== "delivered";
              return `
          <tr>
            <td>${escapeHtml(o.customer_name)}</td>
            <td>${escapeHtml(o.lead_name || "—")}</td>
            <td><span class="status status-${escapeHtml(o.status)}">${escapeHtml(
              o.status?.charAt(0).toUpperCase() + (o.status?.slice(1) || "")
            )}</span></td>
            <td><span class="status ${deliveryClass}">${escapeHtml(deliveryLabel)}</span></td>
            <td>${escapeHtml(date)}</td>
            <td>Rs ${escapeHtml(Number(o.order_value || 0).toLocaleString())}</td>
            ${
              actions
                ? `<td class="actions">
                    <a href="/orders/${o.id}/edit" class="button small">Edit</a>
                    <button type="button" class="button small secondary copy-whatsapp" data-order-text="${escapeHtml(
                      whatsappOrderText(o as OrderWithLead, date)
                    )}">Copy for WhatsApp</button>
                    ${
                      canDeliver
                        ? `<form method="post" action="/orders/${o.id}/deliver" class="inline">
                             <button type="submit" class="button small success">Deliver</button>
                           </form>`
                        : ""
                    }
                    <form method="post" action="/orders/${o.id}/delete" class="inline">
                      <button type="submit" class="button small danger" onclick="return confirm('Delete this order?')">Delete</button>
                    </form>
                  </td>`
                : ""
            }
          </tr>`;
            }
          )
          .join("")}
      </tbody>
    </table>`;
}

app.get("/products", requireAuth, async (req, res) => {
  const { q } = req.query as { q?: string };
  let where = "WHERE 1=1";
  const params: (string | undefined)[] = [];
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR sku ILIKE $${params.length})`;
  }

  const result = await pool.query(
    `SELECT id, name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton FROM products ${where} ORDER BY updated_at DESC`,
    params
  );

  res.send(
    page(
      "Products",
      `
      <div class="page-title-row">
        <h1>Products</h1>
        <a href="/products/new" class="button">+ New Product</a>
      </div>
      <div class="toolbar">
        <form method="get" class="filters">
          <input type="search" name="q" value="${escapeHtml(q || "")}" placeholder="Search products...">
          <button type="submit">Filter</button>
        </form>
      </div>
      <div class="table-wrap">${productsTable(result.rows, true)}</div>`,
      req.session.user!.name
    )
  );
});

app.get("/products/new", requireAuth, (req, res) => {
  res.send(
    page(
      "New Product",
      `
      <h1>New Product</h1>
      <form method="post" action="/products" class="form-grid">
        ${productFormFields({})}
        <div class="actions">
          <button type="submit">Save Product</button>
          <a href="/products" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req.session.user!.name
    )
  );
});

app.post("/products", requireAuth, async (req, res) => {
  const { name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton } = req.body;
  await pool.query(
    "INSERT INTO products (name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [name, sku || null, description || null, parseFloat(cost_price) || 0, parseFloat(selling_price) || 0, parseFloat(stock_kg) || 0, parseFloat(kg_per_sachet) || 1, parseFloat(sachets_per_carton) || 1]
  );
  setFlash(req, "Product created");
  res.redirect("/products");
});

app.get("/products/:id/edit", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  const product = result.rows[0] as Product | undefined;
  if (!product) {
    res.status(404).send(page("Not Found", "<h1>Product not found</h1>", req.session.user!.name));
    return;
  }
  res.send(
    page(
      "Edit Product",
      `
      <h1>Edit Product</h1>
      <form method="post" action="/products/${escapeHtml(product.id)}/update" class="form-grid">
        ${productFormFields(product)}
        <div class="actions">
          <button type="submit">Update Product</button>
          <a href="/products" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req.session.user!.name
    )
  );
});

app.post("/products/:id/update", requireAuth, async (req, res) => {
  const { name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton } = req.body;
  await pool.query(
    "UPDATE products SET name = $1, sku = $2, description = $3, cost_price = $4, selling_price = $5, stock_kg = $6, kg_per_sachet = $7, sachets_per_carton = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9",
    [name, sku || null, description || null, parseFloat(cost_price) || 0, parseFloat(selling_price) || 0, parseFloat(stock_kg) || 0, parseFloat(kg_per_sachet) || 1, parseFloat(sachets_per_carton) || 1, req.params.id]
  );
  setFlash(req, "Product updated");
  res.redirect("/products");
});

app.post("/products/:id/delete", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
    setFlash(req, "Product deleted");
  } catch (err: any) {
    if (err.code === "23503") {
      setFlash(req, "Cannot delete: this product is used in orders", "error");
    } else {
      setFlash(req, "Failed to delete product", "error");
    }
  }
  res.redirect("/products");
});

function productFormFields(product: Partial<Product>): string {
  return `
    <label>Name *<input type="text" name="name" value="${escapeHtml(product.name)}" required></label>
    <label>SKU<input type="text" name="sku" value="${escapeHtml(product.sku)}"></label>
    <label>Cost Price (Rs per kg) *<input type="number" step="0.01" name="cost_price" value="${escapeHtml(
      product.cost_price ?? ""
    )}" required></label>
    <label>Selling Price (Rs per kg) *<input type="number" step="0.01" name="selling_price" value="${escapeHtml(
      product.selling_price ?? ""
    )}" required></label>
    <label>Stock (kg) *<input type="number" step="0.01" name="stock_kg" id="stock-kg" value="${escapeHtml(
      product.stock_kg ?? ""
    )}" required></label>
    <label>Kg per Sachet *<input type="number" step="0.0001" name="kg_per_sachet" id="kg-per-sachet" value="${escapeHtml(
      product.kg_per_sachet ?? ""
    )}" required placeholder="e.g. 0.25"></label>
    <label>Sachets per Carton *<input type="number" step="0.01" name="sachets_per_carton" id="sachets-per-carton" value="${escapeHtml(
      product.sachets_per_carton ?? ""
    )}" required placeholder="e.g. 40"></label>
    <p class="full carton-hint" id="carton-hint">Enter stock, kg per sachet and sachets per carton to see total cartons.</p>
    <label class="full">Description<textarea name="description" rows="4">${escapeHtml(
      product.description
    )}</textarea></label>
  `;
}

function productsTable(rows: Partial<Product>[], actions = false): string {
  if (rows.length === 0) return "<p class=\"empty\">No products found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>Name</th><th>SKU</th><th>Cost/kg</th><th>Selling/kg</th><th>Margin/kg</th><th>Stock (kg)</th><th>Kg/Sachet</th><th>Sachets/Carton</th><th>Sachets</th><th>Cartons</th><th>Description</th>${
          actions ? "<th>Actions</th>" : ""
        }</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (p) => {
              const margin = (p.selling_price || 0) - (p.cost_price || 0);
              const kgPerSachet = (p.kg_per_sachet || 1) > 0 ? (p.kg_per_sachet || 1) : 1;
              const sachetsPerCarton = (p.sachets_per_carton || 1) > 0 ? (p.sachets_per_carton || 1) : 1;
              const sachets = (p.stock_kg || 0) / kgPerSachet;
              const cartons = sachets / sachetsPerCarton;
              return `
          <tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(p.sku)}</td>
            <td>Rs ${escapeHtml(Number(p.cost_price || 0).toLocaleString())}</td>
            <td>Rs ${escapeHtml(Number(p.selling_price || 0).toLocaleString())}</td>
            <td>Rs ${escapeHtml(Number(margin).toLocaleString())}</td>
            <td>${escapeHtml(Number(p.stock_kg || 0).toLocaleString())} kg</td>
            <td>${escapeHtml(Number(kgPerSachet).toLocaleString(undefined, { maximumFractionDigits: 4 }))} kg</td>
            <td>${escapeHtml(Number(sachetsPerCarton).toLocaleString(undefined, { maximumFractionDigits: 2 }))}</td>
            <td>${escapeHtml(Number(sachets).toLocaleString(undefined, { maximumFractionDigits: 2 }))}</td>
            <td>${escapeHtml(Number(cartons).toLocaleString(undefined, { maximumFractionDigits: 2 }))}</td>
            <td>${escapeHtml(p.description)}</td>
            ${
              actions
                ? `<td class="actions">
                    <a href="/products/${p.id}/edit" class="button small">Edit</a>
                    <form method="post" action="/products/${p.id}/delete" class="inline">
                      <button type="submit" class="button small danger" onclick="return confirm('Delete this product?')">Delete</button>
                    </form>
                  </td>`
                : ""
            }
          </tr>`;
            }
          )
          .join("")}
      </tbody>
    </table>`;
}

app.get("/reports", requireAuth, async (req, res) => {
  const funnel = await pool.query(
    `SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY count DESC`
  );
  const monthly = await pool.query(
    `SELECT TO_CHAR(order_date, 'YYYY-MM') as month, COUNT(*) as orders, COALESCE(SUM(order_value), 0) as revenue
     FROM orders
     WHERE order_date >= CURRENT_DATE - INTERVAL '12 months'
     GROUP BY month
     ORDER BY month DESC`
  );
  const conversion = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'converted') as converted, COUNT(*) as total FROM leads`
  );

  const conv = conversion.rows[0];
  const convRate = conv.total > 0 ? ((conv.converted / conv.total) * 100).toFixed(1) : "0.0";

  res.send(
    page(
      "Reports",
      `
      <h1>Reports</h1>
      <section class="stats">
        <div class="card highlight"><strong>${escapeHtml(convRate)}%</strong><span>Lead Conversion Rate</span></div>
      </section>
      <section>
        <h2>Lead Funnel</h2>
        <table class="data-table">
          <thead><tr><th>Status</th><th>Count</th></tr></thead>
          <tbody>
            ${funnel.rows
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.count)}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Monthly Revenue (last 12 months)</h2>
        <table class="data-table">
          <thead><tr><th>Month</th><th>Orders</th><th>Revenue</th></tr></thead>
          <tbody>
            ${monthly.rows
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.month)}</td><td>${escapeHtml(
                    r.orders
                  )}</td><td>Rs ${escapeHtml(Number(r.revenue).toLocaleString())}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      </section>`,
      req.session.user!.name
    )
  );
});

function csvRow(cells: (string | number | null)[]): string {
  return cells
    .map((cell) => {
      const str = String(cell ?? "");
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(",");
}

app.get("/export/leads", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, company, email, phone, status, value, notes, created_at, updated_at FROM leads ORDER BY id"
  );
  const lines = [
    csvRow(["ID", "Name", "Company", "Email", "Phone", "Status", "Value", "Notes", "Created", "Updated"]),
    ...result.rows.map((r) =>
      csvRow([
        r.id,
        r.name,
        r.company,
        r.email,
        r.phone,
        r.status,
        r.value,
        r.notes,
        r.created_at,
        r.updated_at,
      ])
    ),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=leads.csv");
  res.send(lines.join("\n"));
});

app.get("/export/orders", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT o.id, o.customer_name, l.name as lead_name, o.status, o.order_date, o.delivery_status, o.delivery_address, o.shipped_date, o.order_value, o.notes, o.created_at, o.updated_at FROM orders o LEFT JOIN leads l ON o.lead_id = l.id ORDER BY o.id"
  );
  const lines = [
    csvRow(["ID", "Customer", "Lead", "Status", "Date", "Delivery Status", "Delivery Address", "Shipped Date", "Value", "Notes", "Created", "Updated"]),
    ...result.rows.map((r) =>
      csvRow([
        r.id,
        r.customer_name,
        r.lead_name,
        r.status,
        r.order_date,
        r.delivery_status,
        r.delivery_address,
        r.shipped_date,
        r.order_value,
        r.notes,
        r.created_at,
        r.updated_at,
      ])
    ),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=orders.csv");
  res.send(lines.join("\n"));
});

async function main(): Promise<void> {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Leads & Orders app running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
