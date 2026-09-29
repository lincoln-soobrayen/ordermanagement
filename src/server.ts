import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import path from "path";
import dotenv from "dotenv";
import { pool, initDb, Lead, Order, OrderItem, Product, User } from "./db";
import { authenticateUser, isAdmin, isDriver, hashPassword, buildPasswordResetUrl, sendPasswordResetEmail, createPasswordResetToken, consumePasswordResetToken } from "./auth";
import { page, escapeHtml, alertHtml, statusOptions } from "./views";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "default-secret-change-me";

declare module "express-session" {
  interface SessionData {
    user?: User;
    flash?: { message: string; type: "success" | "error" };
    resetUserId?: number;
    resetToken?: string;
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

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && isAdmin(req)) {
    next();
  } else {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1><p>You do not have permission to view this page.</p>", req));
  }
}

function renderPage(title: string, body: string, req: Request): string {
  const f = flash(req);
  const wrappedBody = `${f.message ? alertHtml(f.message, f.type) : ""}${body}`;
  return page(title, wrappedBody, req.session.user?.name, isAdmin(req), isDriver(req));
}

function requireDriverOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && isDriver(req)) {
    next();
  } else {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1><p>This page is for drivers only.</p>", req));
  }
}

function blockDriver(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && isDriver(req)) {
    res.redirect("/deliveries");
    return;
  }
  next();
}

interface FilterClause {
  where: string;
  params: (string | number | undefined)[];
}

async function leadFilter(req: Request, alias: string = "leads"): Promise<FilterClause> {
  if (isAdmin(req)) return { where: "", params: [] };
  return { where: ` AND ${alias}.assigned_to = $1`, params: [req.session.user!.id] };
}

async function orderFilter(req: Request, alias: string = "orders"): Promise<FilterClause> {
  if (isAdmin(req) || isDriver(req)) return { where: "", params: [] };
  return { where: ` AND ${alias}.user_id = $1`, params: [req.session.user!.id] };
}

async function canAccessLead(req: Request, leadId: number): Promise<boolean> {
  if (isAdmin(req)) return true;
  const result = await pool.query("SELECT 1 FROM leads WHERE id = $1 AND assigned_to = $2", [
    leadId,
    req.session.user!.id,
  ]);
  return result.rows.length > 0;
}

async function canAccessOrder(req: Request, orderId: number): Promise<boolean> {
  if (isAdmin(req)) return true;
  if (isDriver(req)) {
    const result = await pool.query("SELECT 1 FROM orders WHERE id = $1 AND driver_id = $2", [
      orderId,
      req.session.user!.id,
    ]);
    return result.rows.length > 0;
  }
  const result = await pool.query("SELECT 1 FROM orders WHERE id = $1 AND user_id = $2", [
    orderId,
    req.session.user!.id,
  ]);
  return result.rows.length > 0;
}

async function canAccessDelivery(req: Request, orderId: number): Promise<boolean> {
  if (isAdmin(req) || !isDriver(req)) return true;
  const result = await pool.query("SELECT 1 FROM orders WHERE id = $1 AND driver_id = $2", [
    orderId,
    req.session.user!.id,
  ]);
  return result.rows.length > 0;
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
  const f = flash(req);
  res.send(
    page(
      "Login",
      `
      <div class="login-box">
        <h1>Login</h1>
        ${f.message ? alertHtml(f.message, f.type) : ""}
        <form method="post" action="/login">
          <label>Email<input type="email" name="email" required autofocus></label>
          <label>Password<input type="password" name="password" required></label>
          <button type="submit">Sign in</button>
        </form>
        <p class="hint"><a href="/forgot-password">Forgot password?</a></p>
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
    if (user.role === "driver") {
      res.redirect("/deliveries");
    } else {
      res.redirect("/dashboard");
    }
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

app.get("/forgot-password", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  res.send(
    page(
      "Forgot Password",
      `
      <div class="login-box">
        <h1>Forgot Password</h1>
        <form method="post" action="/forgot-password">
          <label>Email<input type="email" name="email" required autofocus></label>
          <button type="submit">Send reset link</button>
        </form>
        <p class="hint"><a href="/login">Back to login</a></p>
      </div>`,
      undefined
    )
  );
});

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  const userResult = await pool.query("SELECT id, email, name FROM users WHERE email = $1 AND is_active = true", [email]);
  const user = userResult.rows[0];
  if (user) {
    try {
      const token = await createPasswordResetToken(user.id);
      const resetUrl = buildPasswordResetUrl(token);
      await sendPasswordResetEmail(user, resetUrl);
    } catch (err) {
      console.error("Failed to send self-service reset email:", err);
    }
  }
  // Always show the same message to avoid leaking whether the email exists
  setFlash(req, "If that email is registered, a reset link has been sent.");
  res.redirect("/login");
});

app.get("/reset-password", async (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token) {
    res.status(400).send(renderPage("Invalid Link", "<h1>Invalid or expired reset link</h1>", req));
    return;
  }
  const userId = await consumePasswordResetToken(token);
  if (!userId) {
    res.status(400).send(renderPage("Invalid Link", "<h1>Invalid or expired reset link</h1>", req));
    return;
  }
  // Store user id temporarily in session so the POST can update it without exposing it
  req.session.resetUserId = userId;
  req.session.resetToken = token;
  res.send(
    renderPage(
      "Reset Password",
      `
      <h1>Reset Password</h1>
      <form method="post" action="/reset-password" class="form-grid">
        <label>New Password *<input type="password" name="password" required minlength="6"></label>
        <label>Confirm Password *<input type="password" name="password_confirm" required minlength="6"></label>
        <div class="actions">
          <button type="submit">Update Password</button>
        </div>
      </form>`,
      req
    )
  );
});

app.post("/reset-password", async (req, res) => {
  const { password, password_confirm } = req.body;
  const userId = req.session.resetUserId;
  if (!userId) {
    setFlash(req, "Reset link has expired. Please request a new one.", "error");
    res.redirect("/forgot-password");
    return;
  }
  if (password !== password_confirm) {
    setFlash(req, "Passwords do not match", "error");
    res.redirect(`/reset-password?token=${encodeURIComponent(req.session.resetToken || "")}`);
    return;
  }
  const hash = await hashPassword(password);
  await pool.query("UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [hash, userId]);
  delete req.session.resetUserId;
  delete req.session.resetToken;
  setFlash(req, "Password updated. Please sign in.");
  res.redirect("/login");
});

app.get("/", requireAuth, blockDriver, (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", requireAuth, blockDriver, async (req, res) => {
  const leadF = await leadFilter(req);
  const orderF = await orderFilter(req);

  const leadCounts = await pool.query(
    `SELECT status, COUNT(*) as count FROM leads WHERE 1=1${leadF.where} GROUP BY status ORDER BY status`,
    leadF.params
  );
  const orderCounts = await pool.query(
    `SELECT status, COUNT(*) as count FROM orders WHERE 1=1${orderF.where} GROUP BY status ORDER BY status`,
    orderF.params
  );
  const leadTotals = await pool.query(
    `SELECT COALESCE(SUM(value), 0) as leads_value FROM leads WHERE 1=1${leadF.where}`,
    leadF.params
  );
  const orderTotals = await pool.query(
    `SELECT COALESCE(SUM(order_value), 0) as orders_value FROM orders WHERE 1=1${orderF.where}`,
    orderF.params
  );
  const recentLeads = await pool.query(
    `SELECT id, name, status, value FROM leads WHERE 1=1${leadF.where} ORDER BY updated_at DESC LIMIT 5`,
    leadF.params
  );
  const recentOrders = await pool.query(
    `SELECT id, customer_name, status, order_value FROM orders WHERE 1=1${orderF.where} ORDER BY updated_at DESC LIMIT 5`,
    orderF.params
  );

  const leadValue = leadTotals.rows[0]?.leads_value || 0;
  const orderValue = orderTotals.rows[0]?.orders_value || 0;

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
    renderPage(
      "Dashboard",
      `
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
      req
    )
  );
});

const leadStatuses = ["new", "contacted", "qualified", "converted", "lost"];
const orderStatuses = ["order_placed", "pending", "confirmed", "shipped", "completed", "cancelled"];
const deliveryStatuses = ["not_shipped", "shipped", "in_transit", "delivered", "returned"];

function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DateRange {
  from: string;
  to: string;
  label: string;
}

function getDateRange(preset: string): DateRange {
  const today = new Date();
  const firstDayOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const lastDayOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);

  switch (preset) {
    case "last_7_days":
      return { from: localIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)), to: localIso(today), label: "Last 7 days" };
    case "last_30_days":
      return { from: localIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: localIso(today), label: "Last 30 days" };
    case "this_month":
      return { from: localIso(firstDayOfMonth(today)), to: localIso(today), label: "This month" };
    case "last_month": {
      const firstDayThisMonth = firstDayOfMonth(today);
      const lastMonth = new Date(firstDayThisMonth.getFullYear(), firstDayThisMonth.getMonth() - 1, 1);
      return { from: localIso(lastMonth), to: localIso(lastDayOfMonth(lastMonth)), label: "Last month" };
    }
    case "this_year":
      return { from: `${today.getFullYear()}-01-01`, to: localIso(today), label: "This year" };
    case "last_year": {
      const year = today.getFullYear() - 1;
      return { from: `${year}-01-01`, to: `${year}-12-31`, label: "Last year" };
    }
    case "all_time":
      return { from: "", to: "", label: "All time" };
    default:
      return { from: localIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: localIso(today), label: "Last 30 days" };
  }
}

function formatPeriodLabel(groupBy: string, period: string): string {
  if (!period) return "";
  if (groupBy === "year") return period;
  if (groupBy === "month") {
    const [y, m] = period.split("-");
    if (y && m) {
      const date = new Date(Number(y), Number(m) - 1, 1);
      return date.toLocaleString("default", { month: "short", year: "numeric" });
    }
    return period;
  }
  const date = new Date(period);
  if (isNaN(date.getTime())) return period;
  return date.toLocaleString("default", { month: "short", day: "numeric" });
}

type OrderWithProduct = Partial<Order> & { product_id?: number };
type OrderWithLead = Order & { lead_name?: string; owner_name?: string; owner_role?: string; driver_name?: string; product_id?: number; quantity_kg?: number; quantity_sachets?: number; quantity_cartons?: number; delivery_date_formatted?: string };

app.get("/leads", requireAuth, blockDriver, async (req, res) => {
  const { status, q } = req.query as { status?: string; q?: string };
  const leadF = await leadFilter(req);
  let where = "WHERE 1=1";
  const params: (string | number | undefined)[] = [...leadF.params];
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (name ILIKE $${params.length} OR company ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }

  const result = await pool.query(
    `SELECT id, name, company, email, phone, status, value FROM leads ${where}${leadF.where} ORDER BY updated_at DESC`,
    params
  );

  res.send(
    renderPage(
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
      req
    )
  );
});

app.get("/leads/new", requireAuth, blockDriver, (req, res) => {
  res.send(
    renderPage(
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
      req
    )
  );
});

app.post("/leads", requireAuth, blockDriver, async (req, res) => {
  const { name, company, email, phone, status, value, delivery_location, notes } = req.body;
  await pool.query(
    "INSERT INTO leads (name, company, email, phone, status, value, delivery_location, notes, assigned_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [name, company || null, email || null, phone || null, status || "new", parseFloat(value) || 0, delivery_location || null, notes || null, req.session.user!.id]
  );
  setFlash(req, "Lead created");
  res.redirect("/leads");
});

app.get("/leads/:id/edit", requireAuth, blockDriver, async (req, res) => {
  const result = await pool.query("SELECT * FROM leads WHERE id = $1", [req.params.id]);
  const lead = result.rows[0] as Lead | undefined;
  if (!lead) {
    res.status(404).send(renderPage("Not Found", "<h1>Lead not found</h1>", req));
    return;
  }
  if (!(await canAccessLead(req, lead.id))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  res.send(
    renderPage(
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
      req
    )
  );
});

app.post("/leads/:id/update", requireAuth, blockDriver, async (req, res) => {
  if (!(await canAccessLead(req, parseInt(req.params.id, 10)))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  const { name, company, email, phone, status, value, delivery_location, notes } = req.body;
  await pool.query(
    "UPDATE leads SET name = $1, company = $2, email = $3, phone = $4, status = $5, value = $6, delivery_location = $7, notes = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9",
    [name, company || null, email || null, phone || null, status || "new", parseFloat(value) || 0, delivery_location || null, notes || null, req.params.id]
  );
  setFlash(req, "Lead updated");
  res.redirect("/leads");
});

app.post("/leads/:id/delete", requireAuth, blockDriver, async (req, res) => {
  if (!(await canAccessLead(req, parseInt(req.params.id, 10)))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  await pool.query("DELETE FROM leads WHERE id = $1", [req.params.id]);
  setFlash(req, "Lead deleted");
  res.redirect("/leads");
});

app.get("/leads/:id/notes", requireAuth, blockDriver, async (req, res) => {
  const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1", [
    req.params.id,
  ]);
  const lead = leadResult.rows[0] as Lead | undefined;
  if (!lead) {
    res.status(404).send(renderPage("Not Found", "<h1>Lead not found</h1>", req));
    return;
  }
  if (!(await canAccessLead(req, lead.id))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
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
    renderPage(
      "Lead Notes",
      `
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
      req
    )
  );
});

app.post("/leads/:id/comments", requireAuth, blockDriver, async (req, res) => {
  if (!(await canAccessLead(req, parseInt(req.params.id, 10)))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
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

app.post("/leads/:id/comments/:commentId/delete", requireAuth, blockDriver, async (req, res) => {
  if (!(await canAccessLead(req, parseInt(req.params.id, 10)))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
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

app.get("/orders", requireAuth, blockDriver, async (req, res) => {
  const { status, q } = req.query as { status?: string; q?: string };
  const orderF = await orderFilter(req, "o");
  let where = "WHERE 1=1";
  const params: (string | number | undefined)[] = [...orderF.params];
  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (o.customer_name ILIKE $${params.length})`;
  }

  const result = await pool.query(
    `SELECT o.*, l.name as lead_name, u.name as owner_name, u.role as owner_role, oi.quantity_sachets, oi.quantity_cartons FROM orders o LEFT JOIN leads l ON o.lead_id = l.id LEFT JOIN users u ON o.user_id = u.id LEFT JOIN order_items oi ON o.id = oi.order_id ${where}${orderF.where} ORDER BY o.order_date DESC`,
    params
  );

  res.send(
    renderPage(
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
      req
    )
  );
});

app.get("/orders/new", requireAuth, blockDriver, async (req, res) => {
  const { lead_id, product_id } = req.query as { lead_id?: string; product_id?: string };
  let prefilled: Partial<Order> = {};
  const leadF = await leadFilter(req);
  const orderF = await orderFilter(req);
  let leads = await pool.query(
    `SELECT id, name FROM leads WHERE 1=1${leadF.where} ORDER BY name`,
    leadF.params
  );
  let products = await pool.query("SELECT id, name, cost_price, selling_price, kg_per_sachet, sachets_per_carton FROM products ORDER BY name");
  let owners: { id: number; name: string; role: string }[] = [];
  if (isAdmin(req)) {
    owners = (await pool.query("SELECT id, name, role FROM users WHERE role = 'salesperson' AND is_active = true ORDER BY name")).rows;
  } else {
    const meResult = await pool.query(
      "SELECT id, name, role FROM users WHERE id = $1 LIMIT 1",
      [req.session.user!.id]
    );
    owners = meResult.rows;
    if (meResult.rows[0]) {
      prefilled.user_id = meResult.rows[0].id;
    }
  }
  const drivers = (await pool.query("SELECT id, name FROM users WHERE role = 'driver' AND is_active = true ORDER BY name")).rows;
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
    renderPage(
      "New Order",
      `
      <h1>New Order</h1>
      <form method="post" action="/orders" class="form-grid">
        ${orderFormFields(prefilled, leads.rows, products.rows, owners, drivers)}
        <div class="actions">
          <button type="submit">Save Order</button>
          <a href="/orders" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req
    )
  );
});

app.post("/orders", requireAuth, blockDriver, async (req, res) => {
  const { lead_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, customer_name, delivery_status, delivery_address, delivery_date, notes, driver_id } = req.body;
  const admin = isAdmin(req);
  let user_id = req.body.user_id;
  if (!admin) {
    user_id = req.session.user!.id;
    if (lead_id && !(await canAccessLead(req, parseInt(lead_id, 10)))) {
      res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
      return;
    }
  }
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
      "INSERT INTO orders (lead_id, user_id, driver_id, customer_name, order_value, status, order_date, delivery_status, delivery_address, delivery_date, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
      [
        lead_id || null,
        user_id || null,
        driver_id || null,
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

app.get("/orders/:id/edit", requireAuth, blockDriver, async (req, res) => {
  const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = result.rows[0] as Order | undefined;
  if (!order) {
    res.status(404).send(renderPage("Not Found", "<h1>Order not found</h1>", req));
    return;
  }
  if (!(await canAccessOrder(req, order.id))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  const leadF = await leadFilter(req);
  const leads = await pool.query(
    `SELECT id, name FROM leads WHERE 1=1${leadF.where} ORDER BY name`,
    leadF.params
  );
  const products = await pool.query("SELECT id, name, cost_price, selling_price, kg_per_sachet, sachets_per_carton FROM products ORDER BY name");
  let owners: { id: number; name: string; role: string }[] = [];
  if (isAdmin(req)) {
    owners = (await pool.query("SELECT id, name, role FROM users WHERE role = 'salesperson' AND is_active = true ORDER BY name")).rows;
  } else {
    const meResult = await pool.query(
      "SELECT id, name, role FROM users WHERE id = $1 LIMIT 1",
      [req.session.user!.id]
    );
    owners = meResult.rows;
  }
  const drivers = (await pool.query("SELECT id, name FROM users WHERE role = 'driver' AND is_active = true ORDER BY name")).rows;
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
    renderPage(
      "Edit Order",
      `
      <h1>Edit Order</h1>
      <form method="post" action="/orders/${escapeHtml(order.id)}/update" class="form-grid">
        ${orderFormFields(order, leads.rows, products.rows, owners, drivers)}
        <div class="actions">
          <button type="submit">Update Order</button>
          <a href="/orders" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req
    )
  );
});

app.post("/orders/:id/update", requireAuth, blockDriver, async (req, res) => {
  if (!(await canAccessOrder(req, parseInt(req.params.id, 10)))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  const { lead_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, customer_name, delivery_status, delivery_address, delivery_date, notes, driver_id } = req.body;
  const admin = isAdmin(req);
  let user_id = req.body.user_id;
  if (!admin) {
    user_id = req.session.user!.id;
    if (lead_id && !(await canAccessLead(req, parseInt(lead_id, 10)))) {
      res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
      return;
    }
  }
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
      "UPDATE orders SET lead_id = $1, user_id = $2, driver_id = $3, customer_name = $4, order_value = $5, delivery_status = $6, delivery_address = $7, delivery_date = $8, notes = $9, updated_at = CURRENT_TIMESTAMP WHERE id = $10",
      [
        lead_id || null,
        user_id || null,
        driver_id || null,
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
  const orderId = parseInt(req.params.id, 10);
  if (!(await canAccessDelivery(req, orderId))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  await pool.query(
    "UPDATE orders SET delivery_status = 'delivered', status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    [orderId]
  );
  setFlash(req, "Order marked as delivered");
  res.redirect(isDriver(req) ? "/deliveries" : "/orders");
});

app.post("/orders/:id/delete", requireAuth, blockDriver, async (req, res) => {
  if (!(await canAccessOrder(req, parseInt(req.params.id, 10)))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  setFlash(req, "Order deleted");
  res.redirect("/orders");
});

app.get("/deliveries", requireAuth, async (req, res) => {
  const { status, q } = req.query as { status?: string; q?: string };
  const driver = isDriver(req);
  let where = "WHERE o.status != 'cancelled'";
  const params: (string | number | undefined)[] = [];

  if (driver) {
    params.push(req.session.user!.id);
    where += ` AND o.driver_id = $${params.length}`;
  }

  if (status) {
    params.push(status);
    where += ` AND o.delivery_status = $${params.length}`;
  } else if (!driver) {
    // Default filter for admin/salesperson: show orders still needing delivery
    params.push("not_shipped");
    params.push("shipped");
    params.push("in_transit");
    where += ` AND o.delivery_status IN ($${params.length - 2}, $${params.length - 1}, $${params.length})`;
  }

  if (q) {
    params.push(`%${q}%`);
    where += ` AND o.customer_name ILIKE $${params.length}`;
  }

  const orderF = await orderFilter(req, "o");
  where += orderF.where;
  params.push(...orderF.params);

  const result = await pool.query(
    `SELECT o.*, l.name as lead_name, u.name as owner_name, u.role as owner_role, d.name as driver_name, oi.quantity_sachets, oi.quantity_cartons, oi.quantity_kg
     FROM orders o
     LEFT JOIN leads l ON o.lead_id = l.id
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN users d ON o.driver_id = d.id
     LEFT JOIN order_items oi ON o.id = oi.order_id
     ${where}
     ORDER BY o.delivery_date ASC NULLS LAST, o.order_date DESC`,
    params
  );

  res.send(
    renderPage(
      "Deliveries",
      `
      <div class="page-title-row">
        <h1>🚚 ${driver ? "My Deliveries" : "Deliveries"}</h1>
      </div>
      <div class="toolbar">
        <form method="get" class="filters">
          <input type="search" name="q" value="${escapeHtml(q || "")}" placeholder="Search customer...">
          <select name="status">
            <option value="">${driver ? "All my deliveries" : "Pending deliveries"}</option>
            ${statusOptions(status || "", deliveryStatuses)}
          </select>
          <button type="submit">Filter</button>
        </form>
      </div>
      <div class="table-wrap">${deliveriesTable(result.rows, !driver)}</div>`,
      req
    )
  );
});

function orderFormFields(
  order: OrderWithProduct,
  leads: { id: number; name: string }[],
  products: { id: number; name: string; cost_price: number; selling_price: number; kg_per_sachet: number; sachets_per_carton: number }[] = [],
  owners: { id: number; name: string; role: string }[] = [],
  drivers: { id: number; name: string }[] = []
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
  const ownerOptions = owners
    .map(
      (u) =>
        `<option value="${u.id}" ${u.id === order.user_id ? "selected" : ""}>${escapeHtml(
          `${u.name} (${u.role})`
        )}</option>`
    )
    .join("");
  const ownerSelect = owners.length
    ? `<label>Owner<select name="user_id"><option value="">— none —</option>${ownerOptions}</select></label>`
    : '<p class="empty">No users available.</p>';
  const driverOptions = drivers
    .map(
      (d) =>
        `<option value="${d.id}" ${d.id === order.driver_id ? "selected" : ""}>${escapeHtml(
          d.name
        )}</option>`
    )
    .join("");
  const driverSelect = `<label>Assigned Driver<select name="driver_id"><option value="">— none —</option>${driverOptions}</select></label>`;
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
    ${ownerSelect}
    ${driverSelect}
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
    o.owner_name ? `Owner: ${o.owner_name}${o.owner_role ? ` (${o.owner_role})` : ""}` : null,
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

function deliveriesTable(rows: Partial<OrderWithLead>[], showAdminColumns = false): string {
  if (rows.length === 0) return "<p class=\"empty\">No deliveries found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>Customer</th>${showAdminColumns ? "<th>Driver</th>" : ""}<th>Address</th><th>Delivery Date</th><th>Status</th><th>Quantity</th><th>Value</th><th>Actions</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (o) => {
              const deliveryDate = o.delivery_date
                ? new Date(o.delivery_date).toLocaleString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—";
              const deliveryClass = `status-${escapeHtml(o.delivery_status || "not_shipped")}`;
              const deliveryLabel = o.delivery_status
                ? o.delivery_status.charAt(0).toUpperCase() + o.delivery_status.slice(1).replace(/_/g, " ")
                : "Not shipped";
              const canDeliver = (o.delivery_status || "not_shipped") !== "delivered";
              const qtyParts: string[] = [];
              if (o.quantity_kg && Number(o.quantity_kg) > 0) qtyParts.push(`${Number(o.quantity_kg).toLocaleString(undefined, { maximumFractionDigits: 4 })} kg`);
              if (o.quantity_cartons && Number(o.quantity_cartons) > 0) qtyParts.push(`${Number(o.quantity_cartons).toLocaleString(undefined, { maximumFractionDigits: 2 })} cartons`);
              if (o.quantity_sachets && Number(o.quantity_sachets) > 0) qtyParts.push(`${Number(o.quantity_sachets).toLocaleString(undefined, { maximumFractionDigits: 2 })} sachets`);
              const qtyLine = qtyParts.length > 0 ? qtyParts.join(" / ") : "—";
              return `
          <tr>
            <td>${escapeHtml(o.customer_name)}</td>
            ${showAdminColumns ? `<td>${escapeHtml(o.driver_name || "—")}</td>` : ""}
            <td>${escapeHtml(o.delivery_address || "—")}</td>
            <td>${escapeHtml(deliveryDate)}</td>
            <td><span class="status ${deliveryClass}">${escapeHtml(deliveryLabel)}</span></td>
            <td>${escapeHtml(qtyLine)}</td>
            <td>Rs ${escapeHtml(Number(o.order_value || 0).toLocaleString())}</td>
            <td class="actions">
              <button type="button" class="button small secondary copy-whatsapp" data-order-text="${escapeHtml(
                whatsappOrderText(o as OrderWithLead, new Date(o.order_date || Date.now()).toLocaleDateString())
              )}">Copy</button>
              ${
                canDeliver
                  ? `<form method="post" action="/orders/${o.id}/deliver" class="inline">
                       <button type="submit" class="button small success">Mark Delivered</button>
                     </form>`
                  : `<span class="badge">Delivered</span>`
              }
            </td>
          </tr>`;
            }
          )
          .join("")}
      </tbody>
    </table>`;
}

function ordersTable(rows: Partial<OrderWithLead>[], actions = false): string {
  if (rows.length === 0) return "<p class=\"empty\">No orders found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>Customer</th><th>Lead</th><th>Owner</th><th>Status</th><th>Date</th><th>Value</th>${
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
            <td>${escapeHtml(
              o.owner_name ? `${o.owner_name} (${o.owner_role})` : "—"
            )}</td>
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

app.get("/users", requireAuth, blockDriver, requireAdmin, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, email, role, is_active, created_at FROM users ORDER BY name"
  );
  res.send(
    renderPage(
      "Users",
      `
      <div class="page-title-row">
        <h1>Users</h1>
        <a href="/users/new" class="button">+ New User</a>
      </div>
      <div class="table-wrap">${usersTable(result.rows)}</div>`,
      req
    )
  );
});

app.get("/users/new", requireAuth, blockDriver, requireAdmin, (req, res) => {
  res.send(
    renderPage(
      "New User",
      `
      <h1>New User</h1>
      <form method="post" action="/users" class="form-grid">
        ${userFormFields({})}
        <div class="actions">
          <button type="submit">Save User</button>
          <a href="/users" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req
    )
  );
});

app.post("/users", requireAuth, blockDriver, requireAdmin, async (req, res) => {
  const { name, email, password, role, is_active } = req.body;
  const hash = await hashPassword(password);
  await pool.query(
    "INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, $5)",
    [name, email, hash, role || "salesperson", is_active === "on"]
  );
  setFlash(req, "User created");
  res.redirect("/users");
});

app.get("/users/:id/edit", requireAuth, blockDriver, requireAdmin, async (req, res) => {
  const result = await pool.query("SELECT id, name, email, role, is_active FROM users WHERE id = $1", [
    req.params.id,
  ]);
  const user = result.rows[0];
  if (!user) {
    res.status(404).send(renderPage("Not Found", "<h1>User not found</h1>", req));
    return;
  }
  res.send(
    renderPage(
      "Edit User",
      `
      <h1>Edit User</h1>
      <form method="post" action="/users/${escapeHtml(user.id)}/update" class="form-grid">
        ${userFormFields(user)}
        <div class="actions">
          <button type="submit">Update User</button>
          <a href="/users" class="button secondary">Cancel</a>
        </div>
      </form>`,
      req
    )
  );
});

app.post("/users/:id/update", requireAuth, blockDriver, requireAdmin, async (req, res) => {
  const { name, email, password, role, is_active } = req.body;
  const updates: (string | number | boolean | null)[] = [];
  const fields: string[] = [];
  let paramIndex = 1;
  if (name) {
    fields.push(`name = $${paramIndex++}`);
    updates.push(name);
  }
  if (email) {
    fields.push(`email = $${paramIndex++}`);
    updates.push(email);
  }
  if (password) {
    const hash = await hashPassword(password);
    fields.push(`password_hash = $${paramIndex++}`);
    updates.push(hash);
  }
  if (role) {
    fields.push(`role = $${paramIndex++}`);
    updates.push(role);
  }
  fields.push(`is_active = $${paramIndex++}`);
  updates.push(is_active === "on");
  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  updates.push(req.params.id);
  await pool.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id = $${paramIndex}`,
    updates
  );
  setFlash(req, "User updated");
  res.redirect("/users");
});

app.post("/users/:id/send-reset", requireAuth, blockDriver, requireAdmin, async (req, res) => {
  const userResult = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [req.params.id]);
  const user = userResult.rows[0];
  if (!user) {
    setFlash(req, "User not found", "error");
    res.redirect("/users");
    return;
  }
  try {
    const token = await createPasswordResetToken(user.id);
    const resetUrl = buildPasswordResetUrl(token);
    await sendPasswordResetEmail(user, resetUrl);
    setFlash(req, `Reset link sent to ${user.email}`);
  } catch (err: any) {
    console.error("Failed to send reset link:", err);
    setFlash(req, "Failed to send reset link", "error");
  }
  res.redirect("/users");
});

app.post("/users/:id/delete", requireAuth, blockDriver, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.user!.id) {
    setFlash(req, "You cannot delete your own account", "error");
    res.redirect("/users");
    return;
  }
  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  setFlash(req, "User deleted");
  res.redirect("/users");
});

function userFormFields(user: Partial<User>): string {
  const roles = ["admin", "salesperson", "driver"];
  return `
    <label>Name * <input type="text" name="name" value="${escapeHtml(user.name)}" required></label>
    <label>Email * <input type="email" name="email" value="${escapeHtml(user.email)}" required></label>
    <label>Password ${user.id ? "(leave blank to keep unchanged)" : "*"}<input type="password" name="password" ${user.id ? "" : "required"}></label>
    <label>Role *<select name="role" required>${statusOptions(user.role || "", roles)}</select></label>
    <label class="full">
      <input type="checkbox" name="is_active" ${user.is_active !== false ? "checked" : ""}> Active
    </label>
  `;
}

function usersTable(rows: Partial<User>[]): string {
  if (rows.length === 0) return "<p class=\"empty\">No users found.</p>";
  return `
    <table class="data-table">
      <thead>
        <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (u) => `
          <tr>
            <td>${escapeHtml(u.name)}</td>
            <td>${escapeHtml(u.email)}</td>
            <td>${escapeHtml(u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : "")}</td>
            <td>${escapeHtml(u.is_active ? "Active" : "Inactive")}</td>
            <td class="actions">
              <a href="/users/${u.id}/edit" class="button small">Edit</a>
              <form method="post" action="/users/${u.id}/send-reset" class="inline">
                <button type="submit" class="button small secondary">Reset link</button>
              </form>
              <form method="post" action="/users/${u.id}/delete" class="inline">
                <button type="submit" class="button small danger" onclick="return confirm('Delete this user?')">Delete</button>
              </form>
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

app.get("/products", requireAuth, blockDriver, async (req, res) => {
  const { q } = req.query as { q?: string };
  const admin = isAdmin(req);
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
    renderPage(
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
      req
    )
  );
});

app.get("/products/new", requireAuth, blockDriver, (req, res) => {
  res.send(
    renderPage(
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
      req
    )
  );
});

app.post("/products", requireAuth, blockDriver, async (req, res) => {
  const { name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton } = req.body;
  await pool.query(
    "INSERT INTO products (name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [name, sku || null, description || null, parseFloat(cost_price) || 0, parseFloat(selling_price) || 0, parseFloat(stock_kg) || 0, parseFloat(kg_per_sachet) || 1, parseFloat(sachets_per_carton) || 1]
  );
  setFlash(req, "Product created");
  res.redirect("/products");
});

app.get("/products/:id/edit", requireAuth, blockDriver, async (req, res) => {
  const result = await pool.query("SELECT * FROM products WHERE id = $1", [req.params.id]);
  const product = result.rows[0] as Product | undefined;
  if (!product) {
    res.status(404).send(renderPage("Not Found", "<h1>Product not found</h1>", req));
    return;
  }
  res.send(
    renderPage(
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
      req
    )
  );
});

app.post("/products/:id/update", requireAuth, blockDriver, async (req, res) => {
  const { name, sku, description, cost_price, selling_price, stock_kg, kg_per_sachet, sachets_per_carton } = req.body;
  await pool.query(
    "UPDATE products SET name = $1, sku = $2, description = $3, cost_price = $4, selling_price = $5, stock_kg = $6, kg_per_sachet = $7, sachets_per_carton = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9",
    [name, sku || null, description || null, parseFloat(cost_price) || 0, parseFloat(selling_price) || 0, parseFloat(stock_kg) || 0, parseFloat(kg_per_sachet) || 1, parseFloat(sachets_per_carton) || 1, req.params.id]
  );
  setFlash(req, "Product updated");
  res.redirect("/products");
});

app.post("/products/:id/delete", requireAuth, blockDriver, requireAdmin, async (req, res) => {
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

app.get("/reports", requireAuth, blockDriver, async (req, res) => {
  const leadF = await leadFilter(req);
  const orderF = await orderFilter(req);
  const funnel = await pool.query(
    `SELECT status, COUNT(*) as count FROM leads WHERE 1=1${leadF.where} GROUP BY status ORDER BY count DESC`,
    leadF.params
  );
  const monthly = await pool.query(
    `SELECT TO_CHAR(order_date, 'YYYY-MM') as month, COUNT(*) as orders, COALESCE(SUM(order_value), 0) as revenue
     FROM orders
     WHERE order_date >= CURRENT_DATE - INTERVAL '12 months'${orderF.where}
     GROUP BY month
     ORDER BY month DESC`,
    orderF.params
  );
  const conversion = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'converted') as converted, COUNT(*) as total FROM leads WHERE 1=1${leadF.where}`,
    leadF.params
  );

  const conv = conversion.rows[0];
  const convRate = conv.total > 0 ? ((conv.converted / conv.total) * 100).toFixed(1) : "0.0";

  res.send(
    renderPage(
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
      req
    )
  );
});

app.get("/reports/kg-sales", requireAuth, blockDriver, async (req, res) => {
  const { range, groupBy, status } = req.query as { range?: string; groupBy?: string; status?: string };
  const selectedRange = range || "last_30_days";
  const selectedGroup = groupBy || "day";
  const selectedStatus = status || "all";
  const dateRange = getDateRange(selectedRange);
  const orderF = await orderFilter(req, "o");

  let where = "WHERE 1=1";
  const params: (string | number | undefined)[] = [...orderF.params];
  where += orderF.where;
  if (dateRange.from) {
    params.push(dateRange.from);
    where += ` AND o.order_date >= $${params.length}`;
  }
  if (dateRange.to) {
    params.push(dateRange.to);
    where += ` AND o.order_date <= $${params.length}`;
  }
  if (selectedStatus !== "all") {
    params.push(selectedStatus);
    where += ` AND o.status = $${params.length}`;
  }

  let periodSelect: string;
  let groupByClause: string;
  let orderBy: string;

  switch (selectedGroup) {
    case "month":
      periodSelect = "TO_CHAR(o.order_date, 'YYYY-MM') as period";
      groupByClause = "TO_CHAR(o.order_date, 'YYYY-MM')";
      orderBy = "period";
      break;
    case "year":
      periodSelect = "EXTRACT(YEAR FROM o.order_date)::text as period";
      groupByClause = "EXTRACT(YEAR FROM o.order_date)";
      orderBy = "period";
      break;
    case "day":
    default:
      periodSelect = "o.order_date::text as period";
      groupByClause = "o.order_date";
      orderBy = "o.order_date";
  }

  const result = await pool.query(
    `SELECT ${periodSelect}, COALESCE(SUM(oi.quantity_kg), 0)::float as kg_sold
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     ${where}
     GROUP BY ${groupByClause}
     ORDER BY ${orderBy} ASC`,
    params
  );

  const labels = result.rows.map((r) => formatPeriodLabel(selectedGroup, r.period));
  const data = result.rows.map((r) => Number(r.kg_sold));
  const totalKg = data.reduce((a, b) => a + b, 0);

  const rangeOptions = [
    { value: "last_7_days", label: "Last 7 days" },
    { value: "last_30_days", label: "Last 30 days" },
    { value: "this_month", label: "This month" },
    { value: "last_month", label: "Last month" },
    { value: "this_year", label: "This year" },
    { value: "last_year", label: "Last year" },
    { value: "all_time", label: "All time" },
  ];

  const groupOptions = [
    { value: "day", label: "Per day" },
    { value: "month", label: "Per month" },
    { value: "year", label: "Per year" },
  ];

  const statusFilterOptions = [
    { value: "all", label: "All statuses" },
    { value: "completed", label: "Completed" },
    { value: "order_placed", label: "Order placed" },
    { value: "pending", label: "Pending" },
    { value: "confirmed", label: "Confirmed" },
    { value: "shipped", label: "Shipped" },
    { value: "cancelled", label: "Cancelled" },
  ];

  const selectOptionsHtml = (
    options: { value: string; label: string }[],
    selected: string
  ): string =>
    options
      .map(
        (o) =>
          `<option value="${escapeHtml(o.value)}" ${o.value === selected ? "selected" : ""}>${escapeHtml(
            o.label
          )}</option>`
      )
      .join("");

  const tableRows = result.rows
    .map(
      (r) =>
        `<tr>
          <td>${escapeHtml(formatPeriodLabel(selectedGroup, r.period))}</td>
          <td>${escapeHtml(
            Number(r.kg_sold).toLocaleString(undefined, { maximumFractionDigits: 4 })
          )} kg</td>
        </tr>`
    )
    .join("");

  res.send(
    renderPage(
      "KG Sales Report",
      `
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <h1>KG Sales Report</h1>
      <section class="stats">
        <div class="card highlight"><strong>${escapeHtml(
          totalKg.toLocaleString(undefined, { maximumFractionDigits: 4 })
        )} kg</strong><span>Total ${escapeHtml(dateRange.label.toLowerCase())}${
          selectedStatus !== "all" ? ` (${escapeHtml(selectedStatus.replace(/_/g, " "))})` : ""
        }</span></div>
      </section>
      <section>
        <div class="toolbar">
          <form method="get" class="filters">
            <label>Range
              <select name="range">${selectOptionsHtml(rangeOptions, selectedRange)}</select>
            </label>
            <label>Group by
              <select name="groupBy">${selectOptionsHtml(groupOptions, selectedGroup)}</select>
            </label>
            <label>Status
              <select name="status">${selectOptionsHtml(statusFilterOptions, selectedStatus)}</select>
            </label>
            <button type="submit">Update</button>
          </form>
        </div>
        <div class="chart-wrap">
          <canvas id="kg-sales-chart" height="120"></canvas>
        </div>
      </section>
      <section>
        <h2>Sales Data</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Period</th><th>KG Sold</th></tr></thead>
            <tbody>${
              tableRows || '<tr><td colspan="2" class="empty">No data for selected filters</td></tr>'
            }</tbody>
          </table>
        </div>
      </section>
      <script>
        window.kgSalesData = {
          labels: ${JSON.stringify(labels)},
          data: ${JSON.stringify(data)},
          groupBy: ${JSON.stringify(selectedGroup)},
        };
      </script>`,
      req
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

app.get("/export/leads", requireAuth, blockDriver, async (req, res) => {
  const leadF = await leadFilter(req);
  const result = await pool.query(
    `SELECT id, name, company, email, phone, status, value, notes, created_at, updated_at FROM leads WHERE 1=1${leadF.where} ORDER BY id`,
    leadF.params
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

app.get("/export/orders", requireAuth, blockDriver, async (req, res) => {
  const orderF = await orderFilter(req, "o");
  const result = await pool.query(
    `SELECT o.id, o.customer_name, l.name as lead_name, o.status, o.order_date, o.delivery_status, o.delivery_address, o.shipped_date, o.order_value, o.notes, o.created_at, o.updated_at FROM orders o LEFT JOIN leads l ON o.lead_id = l.id WHERE 1=1${orderF.where} ORDER BY o.id`,
    orderF.params
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
