import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import { pool, requestPoolMiddleware, DEFAULT_FOLLOW_UP_DAYS, INACTIVE_CLIENT_DAYS, MAX_NO_ANSWER_ATTEMPTS, SAMPLE_ORDER_SQL, syncInactiveClientFollowUps, Lead, Order, OrderItem, Product, User } from "./db";
import { authenticateUser, isAdmin, isDriver, hashPassword, buildPasswordResetUrl, sendPasswordResetEmail, createPasswordResetToken, consumePasswordResetToken } from "./auth";
import { page, escapeHtml, alertHtml, statusOptions } from "./views";

export const app = express();
const SESSION_SECRET = process.env.SESSION_SECRET || "default-secret-change-me";
const PgSessionStore = connectPgSimple(session);

declare module "express-session" {
  interface SessionData {
    user?: User;
    flash?: { message: string; type: "success" | "error" };
    resetUserId?: number;
    resetToken?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      followUpsDue?: number;
    }
  }
}

app.use(requestPoolMiddleware);
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new PgSessionStore({
      pool: pool as unknown as Pool,
      tableName: "session",
      pruneSessionInterval: false,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

app.use(async (req, _res, next) => {
  if (req.method !== "GET" || !req.session.user || isDriver(req) || req.path.includes("export")) {
    next();
    return;
  }
  try {
    const leadF = await leadFilter(req, "l");
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM follow_ups f JOIN leads l ON l.id = f.lead_id
       WHERE f.status = 'pending' AND f.due_date <= CURRENT_DATE${leadF.where}`,
      leadF.params
    );
    req.followUpsDue = result.rows[0].n;
  } catch (err) {
    console.error("Follow-up count failed", err);
  }
  next();
});

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
  return page(title, wrappedBody, req.session.user?.name, isAdmin(req), isDriver(req), req.followUpsDue);
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

async function canAccessFollowUp(req: Request, followUpId: number): Promise<boolean> {
  if (isDriver(req)) return false;
  const result = await pool.query(
    `SELECT l.assigned_to FROM follow_ups f JOIN leads l ON l.id = f.lead_id WHERE f.id = $1`,
    [followUpId]
  );
  if (result.rows.length === 0) return false;
  return isAdmin(req) || result.rows[0].assigned_to === req.session.user!.id;
}

// Follow-up bookkeeping must never block an order or delivery from being saved.
async function scheduleDeliveryFollowUp(orderId: number, userId: number | undefined): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO follow_ups (lead_id, order_id, type, due_date, created_by)
       SELECT o.lead_id, o.id,
              CASE WHEN ${SAMPLE_ORDER_SQL} THEN 'sample_feedback' ELSE 'reorder' END,
              CURRENT_DATE + $2::int, $3
       FROM orders o
       WHERE o.id = $1 AND o.lead_id IS NOT NULL AND o.delivery_status = 'delivered' AND o.status != 'cancelled'
       ON CONFLICT DO NOTHING`,
      [orderId, DEFAULT_FOLLOW_UP_DAYS, userId || null]
    );
  } catch (err) {
    console.error("Could not schedule follow-up for order", orderId, err);
  }
}

async function closeFollowUpsForNewOrder(leadId: number, userId: number | undefined, isSample: boolean): Promise<void> {
  const types = isSample ? ["no_recent_order"] : ["reorder", "sample_feedback", "no_recent_order"];
  try {
    await pool.query(
      `UPDATE follow_ups
       SET status = 'done', outcome = 'placed_order', completed_by = $2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE lead_id = $1 AND status IN ('pending', 'unreachable') AND type = ANY($3::text[])`,
      [leadId, userId || null, types]
    );
  } catch (err) {
    console.error("Could not close follow-ups for lead", leadId, err);
  }
}

interface OrderLineInput {
  product_id: number;
  quantity_kg: number;
  quantity_sachets: number;
  quantity_cartons: number;
  unit_price: number;
}

function parseOrderLines(req: Request, isSample: boolean): OrderLineInput[] {
  // express.urlencoded with extended:true strips the [] suffix and gives arrays
  const productIds = req.body.product_id;
  const quantityKgList = req.body.quantity_kg;
  const quantitySachetsList = req.body.quantity_sachets;
  const quantityCartonsList = req.body.quantity_cartons;
  const unitPrices = req.body.unit_price;

  const toArray = (val: any): any[] => {
    if (val === undefined || val === null) return [];
    return Array.isArray(val) ? val : [val];
  };

  const ids = toArray(productIds);
  const kgs = toArray(quantityKgList);
  const sachets = toArray(quantitySachetsList);
  const cartons = toArray(quantityCartonsList);
  const prices = toArray(unitPrices);

  const lines: OrderLineInput[] = [];
  for (let i = 0; i < ids.length; i++) {
    const productId = parseInt(ids[i], 10);
    if (!productId) continue;
    const kg = parseFloat(kgs[i]) || 0;
    const linePrice = isSample ? 0 : (parseFloat(prices[i]) || 0);
    lines.push({
      product_id: productId,
      quantity_kg: kg,
      quantity_sachets: parseFloat(sachets[i]) || 0,
      quantity_cartons: parseFloat(cartons[i]) || 0,
      unit_price: linePrice,
    });
  }
  return lines;
}

async function customerNameFromLead(leadId: string | number | undefined): Promise<string | null> {
  if (!leadId) return null;
  const id = typeof leadId === "number" ? leadId : parseInt(leadId, 10);
  if (!id) return null;
  const result = await pool.query("SELECT name, company FROM leads WHERE id = $1", [id]);
  const lead = result.rows[0];
  if (!lead) return null;
  return lead.company ? `${lead.name} (${lead.company})` : lead.name;
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
const regions = ["north", "south", "east", "west", "center"];

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
    case "last_12_months": {
      const start = new Date(today.getFullYear(), today.getMonth() - 11, 1);
      return { from: localIso(start), to: localIso(today), label: "Last 12 months" };
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
type OrderWithLead = Order & { lead_name?: string; lead_region?: string; owner_name?: string; owner_role?: string; driver_name?: string; product_id?: number; quantity_kg?: number; quantity_sachets?: number; quantity_cartons?: number; delivery_date_formatted?: string };

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
    `SELECT id, name, company, email, phone, status, region, value FROM leads ${where}${leadF.where} ORDER BY updated_at DESC`,
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
  const { name, company, email, phone, status, region, value, delivery_location, notes } = req.body;
  await pool.query(
    "INSERT INTO leads (name, company, email, phone, status, region, value, delivery_location, notes, assigned_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [name, company || null, email || null, phone || null, status || "new", region || null, parseFloat(value) || 0, delivery_location || null, notes || null, req.session.user!.id]
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
  const { name, company, email, phone, status, region, value, delivery_location, notes } = req.body;
  await pool.query(
    "UPDATE leads SET name = $1, company = $2, email = $3, phone = $4, status = $5, region = $6, value = $7, delivery_location = $8, notes = $9, updated_at = CURRENT_TIMESTAMP WHERE id = $10",
    [name, company || null, email || null, phone || null, status || "new", region || null, parseFloat(value) || 0, delivery_location || null, notes || null, req.params.id]
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
    <label>Region<select name="region"><option value="">— Select region —</option>${statusOptions(lead.region || "", regions)}</select></label>
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
        <tr><th>Name</th><th>Company</th><th>Email</th><th>Status</th><th>Region</th><th>Value</th>${
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
            <td>${escapeHtml(l.region ? l.region.charAt(0).toUpperCase() + l.region.slice(1) : "—")}</td>
            <td>Rs ${escapeHtml(Number(l.value || 0).toLocaleString())}</td>
            ${
              actions
                ? `<td class="actions">
                    <a href="/clients/${l.id}" class="button small">History</a>
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
  let leads = await pool.query(
    `SELECT id, name, company FROM leads WHERE 1=1${leadF.where} ORDER BY company, name`,
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
  let initialLines: { product_id?: number; quantity_kg?: number; quantity_sachets?: number; quantity_cartons?: number; unit_price?: number }[] = [];
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
      initialLines = [{
        product_id: parseInt(product_id, 10),
        unit_price: product.selling_price || 0,
        quantity_kg: 0,
        quantity_sachets: 0,
        quantity_cartons: 0,
      }];
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
        ${orderFormFields(prefilled, leads.rows, products.rows, owners, drivers, initialLines)}
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
  const { lead_id, delivery_status, delivery_address, delivery_date, notes, driver_id } = req.body;
  const isSample = Boolean(req.body.is_sample);
  const lines = parseOrderLines(req, isSample);
  const admin = isAdmin(req);
  let user_id = req.body.user_id;
  if (!admin) {
    user_id = req.session.user!.id;
    if (lead_id && !(await canAccessLead(req, parseInt(lead_id, 10)))) {
      res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
      return;
    }
  }
  const customer_name = await customerNameFromLead(lead_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const finalOrderValue = lines.reduce((sum, line) => sum + line.quantity_kg * line.unit_price, 0);
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
    for (const line of lines) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, unit_price) VALUES ($1, $2, $3, $4, $5, $6)",
        [orderResult.rows[0].id, line.product_id, line.quantity_kg, line.quantity_sachets, line.quantity_cartons, line.unit_price]
      );
    }
    await client.query("COMMIT");
    setFlash(req, "Order created");
    const newOrderId = orderResult.rows[0].id as number;
    if (lead_id) await closeFollowUpsForNewOrder(parseInt(lead_id, 10), req.session.user!.id, isSample);
    if (delivery_status === "delivered") await scheduleDeliveryFollowUp(newOrderId, req.session.user!.id);
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
    `SELECT id, name, company FROM leads WHERE 1=1${leadF.where} ORDER BY company, name`,
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
    "SELECT product_id, quantity_kg, quantity_sachets, quantity_cartons, unit_price FROM order_items WHERE order_id = $1 ORDER BY id",
    [req.params.id]
  );
  const editLines = orderItemResult.rows.map((item) => ({
    product_id: item.product_id,
    quantity_kg: item.quantity_kg,
    quantity_sachets: item.quantity_sachets,
    quantity_cartons: item.quantity_cartons,
    unit_price: item.unit_price,
  }));
  if (editLines.length > 0) {
    (order as any).is_sample = (editLines[0].unit_price || 0) === 0;
  }
  res.send(
    renderPage(
      "Edit Order",
      `
      <h1>Edit Order</h1>
      <form method="post" action="/orders/${escapeHtml(order.id)}/update" class="form-grid">
        ${orderFormFields(order, leads.rows, products.rows, owners, drivers, editLines)}
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
  const { lead_id, delivery_status, delivery_address, delivery_date, notes, driver_id } = req.body;
  const isSample = Boolean(req.body.is_sample);
  const lines = parseOrderLines(req, isSample);
  const admin = isAdmin(req);
  let user_id = req.body.user_id;
  if (!admin) {
    user_id = req.session.user!.id;
    if (lead_id && !(await canAccessLead(req, parseInt(lead_id, 10)))) {
      res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
      return;
    }
  }
  const customer_name = await customerNameFromLead(lead_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const finalOrderValue = lines.reduce((sum, line) => sum + line.quantity_kg * line.unit_price, 0);
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
    for (const line of lines) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity_kg, quantity_sachets, quantity_cartons, unit_price) VALUES ($1, $2, $3, $4, $5, $6)",
        [req.params.id, line.product_id, line.quantity_kg, line.quantity_sachets, line.quantity_cartons, line.unit_price]
      );
    }
    await client.query("COMMIT");
    setFlash(req, "Order updated");
    if (delivery_status === "delivered") await scheduleDeliveryFollowUp(parseInt(req.params.id, 10), req.session.user!.id);
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
  await scheduleDeliveryFollowUp(orderId, req.session.user!.id);
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
  const { status, region, q } = req.query as { status?: string; region?: string; q?: string };
  const driver = isDriver(req);
  const orderF = await orderFilter(req, "o");
  let where = `WHERE o.status != 'cancelled'${orderF.where}`;
  const params: (string | number | undefined)[] = [...orderF.params];

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

  if (region) {
    params.push(region);
    where += ` AND l.region = $${params.length}`;
  }

  if (q) {
    params.push(`%${q}%`);
    where += ` AND o.customer_name ILIKE $${params.length}`;
  }

  const result = await pool.query(
    `SELECT o.id, o.lead_id, o.customer_name, o.order_value, o.status, o.order_date, o.delivery_status, o.delivery_address, o.delivery_date, o.shipped_date, o.notes, o.created_at, o.updated_at, l.name as lead_name, l.region as lead_region, u.name as owner_name, u.role as owner_role, d.name as driver_name, oi.quantity_sachets, oi.quantity_cartons, oi.quantity_kg
     FROM orders o
     LEFT JOIN leads l ON o.lead_id = l.id
     LEFT JOIN users u ON o.user_id = u.id
     LEFT JOIN users d ON o.driver_id = d.id
     LEFT JOIN (
       SELECT order_id, SUM(quantity_kg) AS quantity_kg, SUM(quantity_sachets) AS quantity_sachets, SUM(quantity_cartons) AS quantity_cartons
       FROM order_items
       GROUP BY order_id
     ) oi ON o.id = oi.order_id
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
          <select name="region">
            <option value="">All regions</option>
            ${statusOptions(region || "", regions)}
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
  leads: { id: number; name: string; company?: string }[],
  products: { id: number; name: string; cost_price: number; selling_price: number; kg_per_sachet: number; sachets_per_carton: number }[] = [],
  owners: { id: number; name: string; role: string }[] = [],
  drivers: { id: number; name: string }[] = [],
  lines: { product_id?: number; quantity_kg?: number; quantity_sachets?: number; quantity_cartons?: number; unit_price?: number }[] = []
): string {
  const leadOptions = leads
    .map(
      (l) => {
        const label = l.company ? `${l.company} (${l.name})` : l.name;
        return `<option value="${l.id}" data-url="/orders/new?lead_id=${l.id}" ${l.id === order.lead_id ? "selected" : ""}>${escapeHtml(label)}</option>`;
      }
    )
    .join("");
  const productOptions = products
    .map(
      (p) =>
        `<option value="${p.id}" data-selling-price="${p.selling_price || 0}" data-kg-per-sachet="${p.kg_per_sachet || 1}" data-sachets-per-carton="${p.sachets_per_carton || 1}" data-name="${escapeHtml(p.name)}" ${p.id === order.product_id ? "selected" : ""}>${escapeHtml(p.name)} — Rs ${Number(
          p.selling_price || 0
        ).toLocaleString()}/kg</option>`
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
  const isSample = (order as any).is_sample ?? false;
  const initialLines = lines.length > 0 ? lines : [{ product_id: order.product_id || 0, quantity_kg: 0, quantity_sachets: 0, quantity_cartons: 0, unit_price: 0 }];
  const productData = products.map((p) => ({
    id: p.id,
    name: p.name,
    selling_price: p.selling_price || 0,
    kg_per_sachet: p.kg_per_sachet || 1,
    sachets_per_carton: p.sachets_per_carton || 1,
  }));
  const linesJson = JSON.stringify(initialLines);
  const productDataJson = JSON.stringify(productData);
  return `
    <label>Linked Lead<select name="lead_id" id="lead-select"><option value="">— none —</option>${leadOptions}</select></label>
    ${ownerSelect}
    ${driverSelect}
    <label class="full">
      <input type="checkbox" name="is_sample" id="is-sample" value="1" ${isSample ? "checked" : ""}> Sample order (price becomes Rs 0)
    </label>
    <div class="sales-order-lines full">
      <div class="sales-order-header">
        <span class="sales-order-title">Order Lines</span>
        <button type="button" class="button small secondary" id="add-order-line">+ Add Product</button>
      </div>
      <div class="sales-order-table-wrap">
        <table class="sales-order-table" id="sales-order-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty (kg)</th>
              <th>Qty (sachets)</th>
              <th>Qty (cartons)</th>
              <th>Unit Price</th>
              <th>Line Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="sales-order-lines-body">
          </tbody>
        </table>
      </div>
      <p class="empty" id="no-lines-message" style="display: none;">No products added. Click "Add Product" to start.</p>
    </div>
    <div class="total-price-card full">
      <div class="total-price-label">Order Total</div>
      <div class="total-price-amount" id="total-price-display">Rs 0.00</div>
      <div class="total-price-detail" id="total-price-detail">0 items</div>
    </div>
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
    <script>
      window.salesOrderData = {
        lines: ${linesJson},
        products: ${productDataJson},
        isSample: ${isSample ? "true" : "false"}
      };
    </script>
    <template id="sales-order-line-template">
      <tr class="sales-order-line">
        <td>
          <select name="product_id[]" class="line-product" required>
            <option value="">— Select product —</option>
            ${productOptions}
          </select>
        </td>
        <td><input type="number" step="0.0001" name="quantity_kg[]" class="line-qty-kg" placeholder="kg" inputmode="decimal"></td>
        <td><input type="number" step="0.0001" name="quantity_sachets[]" class="line-qty-sachets" placeholder="sachets" inputmode="decimal"></td>
        <td><input type="number" step="0.0001" name="quantity_cartons[]" class="line-qty-cartons" placeholder="cartons" inputmode="decimal"></td>
        <td><input type="number" step="0.01" name="unit_price[]" class="line-unit-price" placeholder="Rs/kg" inputmode="decimal"></td>
        <td class="line-total">Rs 0.00</td>
        <td><button type="button" class="button small danger remove-line">×</button></td>
      </tr>
    </template>
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
        <tr><th>Order ID</th><th>Lead ID</th><th>Customer</th>${showAdminColumns ? "<th>Driver</th>" : ""}<th>Region</th><th>Address</th><th>Delivery Date</th><th>Status</th><th>Quantity</th><th>Value</th><th>Actions</th></tr>
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
              const markDeliveredButton = canDeliver
                ? `<form method="post" action="/orders/${o.id}/deliver" class="inline" onsubmit="return confirm('Mark this order as delivered?')">
                     <button type="submit" class="button small success">Mark Delivered</button>
                   </form>`
                : `<span class="badge">Delivered</span>`;
              const address = o.delivery_address || "—";
              const addressCell =
                address.startsWith("http://") || address.startsWith("https://")
                  ? `<a href="${escapeHtml(address)}" target="_blank" rel="noopener noreferrer">${escapeHtml(address)}</a>`
                  : escapeHtml(address);
              const qtyParts: string[] = [];
              if (o.quantity_kg && Number(o.quantity_kg) > 0) qtyParts.push(`${Number(o.quantity_kg).toLocaleString(undefined, { maximumFractionDigits: 4 })} kg`);
              if (o.quantity_cartons && Number(o.quantity_cartons) > 0) qtyParts.push(`${Number(o.quantity_cartons).toLocaleString(undefined, { maximumFractionDigits: 2 })} cartons`);
              if (o.quantity_sachets && Number(o.quantity_sachets) > 0) qtyParts.push(`${Number(o.quantity_sachets).toLocaleString(undefined, { maximumFractionDigits: 2 })} sachets`);
              const qtyLine = qtyParts.length > 0 ? qtyParts.join(" / ") : "—";
              const regionLabel = o.lead_region
                ? o.lead_region.charAt(0).toUpperCase() + o.lead_region.slice(1)
                : "—";
              return `
          <tr>
            <td>${escapeHtml(o.id)}</td>
            <td>${escapeHtml(o.lead_id || "—")}</td>
            <td>${escapeHtml(o.customer_name)}</td>
            ${showAdminColumns ? `<td>${escapeHtml(o.driver_name || "—")}</td>` : ""}
            <td>${escapeHtml(regionLabel)}</td>
            <td>${addressCell}</td>
            <td>${escapeHtml(deliveryDate)}</td>
            <td><span class="status ${deliveryClass}">${escapeHtml(deliveryLabel)}</span></td>
            <td>${escapeHtml(qtyLine)}</td>
            <td>Rs ${escapeHtml(Number(o.order_value || 0).toLocaleString())}</td>
            <td class="actions">
              <button type="button" class="button small secondary copy-whatsapp" data-order-text="${escapeHtml(
                whatsappOrderText(o as OrderWithLead, new Date(o.order_date || Date.now()).toLocaleDateString())
              )}">Copy</button>
              ${markDeliveredButton}
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
    setFlash(req, `Reset link for ${user.email} (valid 1 hour): ${resetUrl}`);
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

function money(n: number): string {
  return `Rs ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

app.get("/reports/monthly-margin", requireAuth, blockDriver, async (req, res) => {
  const { range } = req.query as { range?: string };
  const selectedRange = range || "last_12_months";
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

  const result = await pool.query(
    `SELECT TO_CHAR(o.order_date, 'YYYY-MM') as month,
            COUNT(DISTINCT o.id) as orders,
            COALESCE(SUM(oi.unit_price * oi.quantity_kg), 0)::numeric as revenue,
            COALESCE(SUM(p.cost_price * oi.quantity_kg), 0)::numeric as cost,
            COALESCE(SUM((oi.unit_price - p.cost_price) * oi.quantity_kg), 0)::numeric as margin
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     JOIN products p ON oi.product_id = p.id
     ${where}
     GROUP BY TO_CHAR(o.order_date, 'YYYY-MM')
     ORDER BY month DESC`,
    params
  );

  const totalRevenue = result.rows.reduce((sum, r) => sum + Number(r.revenue), 0);
  const totalCost = result.rows.reduce((sum, r) => sum + Number(r.cost), 0);
  const totalMargin = result.rows.reduce((sum, r) => sum + Number(r.margin), 0);

  const tableRows = result.rows
    .map(
      (r) =>
        `<tr>
          <td>${escapeHtml(formatPeriodLabel("month", r.month))}</td>
          <td>${escapeHtml(r.orders)}</td>
          <td>${escapeHtml(money(r.revenue))}</td>
          <td>${escapeHtml(money(r.cost))}</td>
          <td>${escapeHtml(money(r.margin))}</td>
        </tr>`
    )
    .join("");

  const rangeOptions = [
    { value: "last_7_days", label: "Last 7 days" },
    { value: "last_30_days", label: "Last 30 days" },
    { value: "this_month", label: "This month" },
    { value: "last_month", label: "Last month" },
    { value: "this_year", label: "This year" },
    { value: "last_year", label: "Last year" },
    { value: "last_12_months", label: "Last 12 months" },
    { value: "all_time", label: "All time" },
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

  res.send(
    renderPage(
      "Monthly Margin Report",
      `
      <h1>Monthly Margin Report</h1>
      <section class="stats">
        <div class="card highlight"><strong>${escapeHtml(money(totalRevenue))}</strong><span>Total Revenue</span></div>
        <div class="card"><strong>${escapeHtml(money(totalCost))}</strong><span>Total Cost</span></div>
        <div class="card"><strong>${escapeHtml(money(totalMargin))}</strong><span>Total Margin</span></div>
      </section>
      <section>
        <div class="toolbar">
          <form method="get" class="filters">
            <label>Range
              <select name="range">${selectOptionsHtml(rangeOptions, selectedRange)}</select>
            </label>
            <button type="submit">Update</button>
          </form>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Month</th><th>Orders</th><th>Revenue</th><th>Cost</th><th>Margin</th></tr></thead>
            <tbody>${tableRows || '<tr><td colspan="5" class="empty">No data for selected range</td></tr>'}</tbody>
          </table>
        </div>
      </section>`,
      req
    )
  );
});

app.get("/reports/client-margin", requireAuth, blockDriver, async (req, res) => {
  const { range, limit } = req.query as { range?: string; limit?: string };
  const selectedRange = range || "last_12_months";
  const selectedLimit = Math.min(parseInt(limit || "20", 10) || 20, 50);
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

  const result = await pool.query(
    `SELECT o.customer_name,
            COUNT(DISTINCT o.id) as orders,
            COALESCE(SUM(oi.unit_price * oi.quantity_kg), 0)::numeric as revenue,
            COALESCE(SUM(p.cost_price * oi.quantity_kg), 0)::numeric as cost,
            COALESCE(SUM((oi.unit_price - p.cost_price) * oi.quantity_kg), 0)::numeric as margin
     FROM orders o
     JOIN order_items oi ON o.id = oi.order_id
     JOIN products p ON oi.product_id = p.id
     ${where}
     GROUP BY o.customer_name
     ORDER BY margin DESC
     LIMIT $${params.length + 1}`,
    [...params, selectedLimit]
  );

  const labels = result.rows.map((r) => r.customer_name);
  const revenueData = result.rows.map((r) => Number(r.revenue));
  const marginData = result.rows.map((r) => Number(r.margin));

  const totalRevenue = revenueData.reduce((a, b) => a + b, 0);
  const totalCost = result.rows.reduce((sum, r) => sum + Number(r.cost), 0);
  const totalMargin = marginData.reduce((a, b) => a + b, 0);

  const tableRows = result.rows
    .map(
      (r) =>
        `<tr>
          <td>${escapeHtml(r.customer_name)}</td>
          <td>${escapeHtml(r.orders)}</td>
          <td>${escapeHtml(money(r.revenue))}</td>
          <td>${escapeHtml(money(r.cost))}</td>
          <td>${escapeHtml(money(r.margin))}</td>
        </tr>`
    )
    .join("");

  const rangeOptions = [
    { value: "last_7_days", label: "Last 7 days" },
    { value: "last_30_days", label: "Last 30 days" },
    { value: "this_month", label: "This month" },
    { value: "last_month", label: "Last month" },
    { value: "this_year", label: "This year" },
    { value: "last_year", label: "Last year" },
    { value: "last_12_months", label: "Last 12 months" },
    { value: "all_time", label: "All time" },
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

  res.send(
    renderPage(
      "Client Margin Report",
      `
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <h1>Client Margin Report</h1>
      <section class="stats">
        <div class="card highlight"><strong>${escapeHtml(money(totalRevenue))}</strong><span>Total Revenue</span></div>
        <div class="card"><strong>${escapeHtml(money(totalCost))}</strong><span>Total Cost</span></div>
        <div class="card"><strong>${escapeHtml(money(totalMargin))}</strong><span>Total Margin</span></div>
      </section>
      <section>
        <div class="toolbar">
          <form method="get" class="filters">
            <label>Range
              <select name="range">${selectOptionsHtml(rangeOptions, selectedRange)}</select>
            </label>
            <label>Top
              <select name="limit">
                <option value="10" ${selectedLimit === 10 ? "selected" : ""}>10 clients</option>
                <option value="20" ${selectedLimit === 20 ? "selected" : ""}>20 clients</option>
                <option value="50" ${selectedLimit === 50 ? "selected" : ""}>50 clients</option>
              </select>
            </label>
            <button type="submit">Update</button>
          </form>
        </div>
        <div class="chart-wrap">
          <canvas id="client-margin-chart" height="120"></canvas>
        </div>
      </section>
      <section>
        <h2>Client Data</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Client</th><th>Orders</th><th>Revenue</th><th>Cost</th><th>Margin</th></tr></thead>
            <tbody>${tableRows || '<tr><td colspan="5" class="empty">No data for selected range</td></tr>'}</tbody>
          </table>
        </div>
      </section>
      <script>
        window.clientMarginData = {
          labels: ${JSON.stringify(labels)},
          revenue: ${JSON.stringify(revenueData)},
          margin: ${JSON.stringify(marginData)},
        };
      </script>`,
      req
    )
  );
});

const clientSortOrders: Record<string, { label: string; sql: string }> = {
  revenue: { label: "Highest revenue", sql: "revenue DESC" },
  margin: { label: "Highest margin", sql: "margin DESC" },
  orders: { label: "Most orders", sql: "orders DESC, revenue DESC" },
  last_order: { label: "Most recent order", sql: "last_order DESC NULLS LAST" },
  open: { label: "Most open deliveries", sql: "open_orders DESC, last_order DESC NULLS LAST" },
  name: { label: "Name (A–Z)", sql: "LOWER(COALESCE(NULLIF(l.company, ''), l.name)) ASC" },
};

const clientRangeOptions = [
  { value: "all_time", label: "All time" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "this_year", label: "This year" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "last_year", label: "Last year" },
];

function optionsHtml(options: { value: string; label: string }[], selected: string): string {
  return options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? "selected" : ""}>${escapeHtml(o.label)}</option>`
    )
    .join("");
}

function labelize(value: string | null | undefined): string {
  if (!value) return "—";
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function qty(n: number | string | null | undefined, digits = 2): string {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function locationHtml(location: string | null | undefined): string {
  if (!location) return "—";
  if (location.startsWith("http://") || location.startsWith("https://")) {
    return `<a href="${escapeHtml(location)}" target="_blank" rel="noopener noreferrer">Map link</a>`;
  }
  return escapeHtml(location);
}

function clientLabel(c: { name: string; company?: string | null }): string {
  return c.company ? `${c.company} (${c.name})` : c.name;
}

interface ClientListFilters {
  q?: string;
  region?: string;
  owner?: string;
  range?: string;
  activity?: string;
  sort?: string;
}

async function queryClients(req: Request, filters: ClientListFilters) {
  const leadF = await leadFilter(req, "l");
  const params: (string | number | undefined)[] = [...leadF.params];

  const dateRange = getDateRange(filters.range || "all_time");
  let orderWhere = "WHERE o.status != 'cancelled'";
  if (dateRange.from) {
    params.push(dateRange.from);
    orderWhere += ` AND o.order_date >= $${params.length}`;
  }
  if (dateRange.to) {
    params.push(dateRange.to);
    orderWhere += ` AND o.order_date <= $${params.length}`;
  }

  let where = `WHERE 1=1${leadF.where}`;
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const p = `$${params.length}`;
    where += ` AND (l.name ILIKE ${p} OR l.company ILIKE ${p} OR l.phone ILIKE ${p} OR l.email ILIKE ${p})`;
  }
  if (filters.region) {
    params.push(filters.region);
    where += ` AND l.region = $${params.length}`;
  }
  const ownerId = parseInt(filters.owner || "", 10);
  if (ownerId && isAdmin(req)) {
    params.push(ownerId);
    where += ` AND l.assigned_to = $${params.length}`;
  }
  if (filters.activity === "with_orders") where += " AND COALESCE(s.orders, 0) > 0";
  if (filters.activity === "no_orders") where += " AND COALESCE(s.orders, 0) = 0";

  const orderBy = (clientSortOrders[filters.sort || ""] || clientSortOrders.revenue).sql;

  return pool.query(
    `SELECT l.id, l.name, l.company, l.phone, l.email, l.region, l.status, owner.name AS owner_name,
            COALESCE(s.orders, 0)::int AS orders,
            COALESCE(s.open_orders, 0)::int AS open_orders,
            COALESCE(s.kg, 0)::numeric AS kg,
            COALESCE(s.revenue, 0)::numeric AS revenue,
            COALESCE(s.cost, 0)::numeric AS cost,
            (COALESCE(s.revenue, 0) - COALESCE(s.cost, 0))::numeric AS margin,
            s.first_order, s.last_order
     FROM leads l
     LEFT JOIN users owner ON owner.id = l.assigned_to
     LEFT JOIN (
       SELECT o.lead_id,
              COUNT(*) AS orders,
              COUNT(*) FILTER (WHERE COALESCE(o.delivery_status, 'not_shipped') NOT IN ('delivered', 'returned')) AS open_orders,
              SUM(COALESCE(t.kg, 0)) AS kg,
              SUM(o.order_value) AS revenue,
              SUM(COALESCE(t.cost, 0)) AS cost,
              MIN(o.order_date) AS first_order,
              MAX(o.order_date) AS last_order
       FROM orders o
       LEFT JOIN (
         SELECT oi.order_id, SUM(oi.quantity_kg) AS kg, SUM(p.cost_price * oi.quantity_kg) AS cost
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         GROUP BY oi.order_id
       ) t ON t.order_id = o.id
       ${orderWhere}
       GROUP BY o.lead_id
     ) s ON s.lead_id = l.id
     ${where}
     ORDER BY ${orderBy}, l.id`,
    params
  );
}

function clientFiltersQuery(filters: ClientListFilters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

app.get("/clients", requireAuth, blockDriver, async (req, res) => {
  const filters = req.query as ClientListFilters;
  const admin = isAdmin(req);
  const result = await queryClients(req, filters);
  const rows = result.rows;
  const owners = admin
    ? (await pool.query("SELECT id, name FROM users WHERE role != 'driver' ORDER BY name")).rows
    : [];

  const totals = rows.reduce(
    (acc, r) => {
      acc.revenue += Number(r.revenue);
      acc.margin += Number(r.margin);
      acc.orders += Number(r.orders);
      acc.open += Number(r.open_orders);
      if (Number(r.orders) > 0) acc.active += 1;
      return acc;
    },
    { revenue: 0, margin: 0, orders: 0, open: 0, active: 0 }
  );

  const tableRows = rows
    .map(
      (r) => `
        <tr>
          <td><a href="/clients/${r.id}"><strong>${escapeHtml(r.company || r.name)}</strong></a>${
            r.company ? `<div class="muted">${escapeHtml(r.name)}</div>` : ""
          }</td>
          <td>${escapeHtml(r.phone || "—")}</td>
          <td>${escapeHtml(labelize(r.region))}</td>
          ${admin ? `<td>${escapeHtml(r.owner_name || "—")}</td>` : ""}
          <td class="num">${escapeHtml(r.orders)}</td>
          <td class="num">${Number(r.open_orders) > 0 ? `<span class="status status-not_shipped">${escapeHtml(r.open_orders)}</span>` : "0"}</td>
          <td class="num">${escapeHtml(qty(r.kg))}</td>
          <td class="num">${escapeHtml(money(r.revenue))}</td>
          <td class="num">${escapeHtml(money(r.margin))}</td>
          <td>${escapeHtml(shortDate(r.last_order))}</td>
          <td class="actions-cell"><a href="/clients/${r.id}" class="button small">View</a></td>
        </tr>`
    )
    .join("");

  const sortOptions = Object.entries(clientSortOrders).map(([value, o]) => ({ value, label: o.label }));
  const activityOptions = [
    { value: "", label: "All clients" },
    { value: "with_orders", label: "With orders" },
    { value: "no_orders", label: "No orders yet" },
  ];

  res.send(
    renderPage(
      "Clients",
      `
      <div class="page-title-row">
        <h1>🏢 Clients</h1>
        <a href="/export/clients${escapeHtml(clientFiltersQuery(filters))}" class="button secondary">Export CSV</a>
      </div>
      <section class="stats">
        <div class="card highlight"><strong>${escapeHtml(rows.length)}</strong><span>Clients (${escapeHtml(totals.active)} with orders)</span></div>
        <div class="card"><strong>${escapeHtml(totals.orders)}</strong><span>Orders</span></div>
        <div class="card"><strong>${escapeHtml(money(totals.revenue))}</strong><span>Revenue</span></div>
        <div class="card"><strong>${escapeHtml(money(totals.margin))}</strong><span>Margin</span></div>
        <div class="card"><strong>${escapeHtml(totals.open)}</strong><span>Open deliveries</span></div>
      </section>
      <div class="toolbar">
        <form method="get" class="filters">
          <input type="search" name="q" value="${escapeHtml(filters.q || "")}" placeholder="Search name, company, phone...">
          <select name="region">
            <option value="">All regions</option>
            ${statusOptions(filters.region || "", regions)}
          </select>
          ${
            admin
              ? `<select name="owner">
                  <option value="">All salespeople</option>
                  ${optionsHtml(owners.map((u) => ({ value: String(u.id), label: u.name })), filters.owner || "")}
                </select>`
              : ""
          }
          <select name="activity">${optionsHtml(activityOptions, filters.activity || "")}</select>
          <select name="range">${optionsHtml(clientRangeOptions, filters.range || "all_time")}</select>
          <select name="sort">${optionsHtml(sortOptions, filters.sort || "revenue")}</select>
          <button type="submit">Filter</button>
        </form>
      </div>
      <div class="table-wrap">
        ${
          rows.length
            ? `<table class="data-table">
                <thead><tr><th>Client</th><th>Phone</th><th>Region</th>${admin ? "<th>Salesperson</th>" : ""}<th class="num">Orders</th><th class="num">Open</th><th class="num">Kg</th><th class="num">Revenue</th><th class="num">Margin</th><th>Last order</th><th></th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>`
            : '<p class="empty">No clients found.</p>'
        }
      </div>
      <p class="hint">Totals exclude cancelled orders. Cost and margin use each product's current cost price.</p>`,
      req
    )
  );
});

app.get("/export/clients", requireAuth, blockDriver, async (req, res) => {
  const result = await queryClients(req, req.query as ClientListFilters);
  const lines = [
    csvRow(["Client ID", "Company", "Contact", "Phone", "Email", "Region", "Salesperson", "Orders", "Open deliveries", "Kg", "Revenue", "Cost", "Margin", "First order", "Last order"]),
    ...result.rows.map((r) =>
      csvRow([
        r.id,
        r.company,
        r.name,
        r.phone,
        r.email,
        r.region,
        r.owner_name,
        r.orders,
        r.open_orders,
        Number(r.kg),
        Number(r.revenue).toFixed(2),
        Number(r.cost).toFixed(2),
        Number(r.margin).toFixed(2),
        r.first_order ? localIso(new Date(r.first_order)) : "",
        r.last_order ? localIso(new Date(r.last_order)) : "",
      ])
    ),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=clients.csv");
  res.send(lines.join("\n"));
});

interface ClientOrderItem {
  order_id: number;
  product_name: string;
  sku: string | null;
  quantity_kg: string;
  quantity_sachets: string;
  quantity_cartons: string;
  unit_price: string;
  cost_price: string;
}

async function loadClientHistory(req: Request, res: Response) {
  const clientId = parseInt(req.params.id, 10);
  const leadResult = clientId
    ? await pool.query(
        `SELECT l.*, owner.name AS owner_name FROM leads l LEFT JOIN users owner ON owner.id = l.assigned_to WHERE l.id = $1`,
        [clientId]
      )
    : { rows: [] };
  const client = leadResult.rows[0] as (Lead & { owner_name: string | null }) | undefined;
  if (!client) {
    res.status(404).send(renderPage("Not Found", "<h1>Client not found</h1>", req));
    return null;
  }
  if (!(await canAccessLead(req, client.id))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return null;
  }

  const range = (req.query.range as string) || "all_time";
  const dateRange = getDateRange(range);
  const params: (string | number)[] = [client.id];
  let where = "WHERE o.lead_id = $1";
  if (dateRange.from) {
    params.push(dateRange.from);
    where += ` AND o.order_date >= $${params.length}`;
  }
  if (dateRange.to) {
    params.push(dateRange.to);
    where += ` AND o.order_date <= $${params.length}`;
  }

  const ordersResult = await pool.query(
    `SELECT o.id, o.user_id, o.order_date, o.status, o.delivery_status, o.delivery_date, o.delivery_address, o.shipped_date,
            o.order_value, o.notes, o.created_at, owner.name AS owner_name, driver.name AS driver_name
     FROM orders o
     LEFT JOIN users owner ON owner.id = o.user_id
     LEFT JOIN users driver ON driver.id = o.driver_id
     ${where}
     ORDER BY o.order_date DESC, o.id DESC`,
    params
  );
  const orders = ordersResult.rows;

  const itemsByOrder = new Map<number, ClientOrderItem[]>();
  if (orders.length) {
    const itemsResult = await pool.query(
      `SELECT oi.order_id, p.name AS product_name, p.sku, oi.quantity_kg, oi.quantity_sachets, oi.quantity_cartons, oi.unit_price, p.cost_price
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ANY($1::int[])
       ORDER BY oi.id`,
      [orders.map((o) => o.id)]
    );
    for (const item of itemsResult.rows as ClientOrderItem[]) {
      const list = itemsByOrder.get(item.order_id) || [];
      list.push(item);
      itemsByOrder.set(item.order_id, list);
    }
  }

  return { client, orders, itemsByOrder, range };
}

app.get("/clients/:id", requireAuth, blockDriver, async (req, res) => {
  const history = await loadClientHistory(req, res);
  if (!history) return;
  const { client, orders, itemsByOrder, range } = history;
  const admin = isAdmin(req);
  const currentUserId = req.session.user!.id;

  const counted = orders.filter((o) => o.status !== "cancelled");
  const productTotals = new Map<string, { kg: number; revenue: number; cost: number; orders: Set<number> }>();
  let revenue = 0;
  let cost = 0;
  let kg = 0;
  for (const o of counted) {
    revenue += Number(o.order_value || 0);
    for (const item of itemsByOrder.get(o.id) || []) {
      const itemKg = Number(item.quantity_kg || 0);
      const itemRevenue = itemKg * Number(item.unit_price || 0);
      const itemCost = itemKg * Number(item.cost_price || 0);
      kg += itemKg;
      cost += itemCost;
      const totals = productTotals.get(item.product_name) || { kg: 0, revenue: 0, cost: 0, orders: new Set<number>() };
      totals.kg += itemKg;
      totals.revenue += itemRevenue;
      totals.cost += itemCost;
      totals.orders.add(o.id);
      productTotals.set(item.product_name, totals);
    }
  }
  const followUpsResult = await pool.query(
    `SELECT f.id, f.type, f.status, f.attempts, f.notes, to_char(f.due_date, 'YYYY-MM-DD') AS due_iso, (f.due_date - CURRENT_DATE) AS days_until,
            to_char(CURRENT_DATE + $2::int, 'YYYY-MM-DD') AS default_iso
     FROM follow_ups f
     WHERE f.lead_id = $1 AND f.status IN ('pending', 'unreachable')
     ORDER BY f.due_date ASC`,
    [client.id, DEFAULT_FOLLOW_UP_DAYS]
  );
  const openFollowUps = followUpsResult.rows;
  const defaultFollowUpIso =
    openFollowUps[0]?.default_iso ||
    (await pool.query("SELECT to_char(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d", [DEFAULT_FOLLOW_UP_DAYS])).rows[0].d;
  const followUpRows = openFollowUps
    .map(
      (f) => `
        <tr>
          <td>${followUpTypeBadge(f.type)}</td>
          <td>${escapeHtml(isoDateLabel(f.due_iso))}</td>
          <td>${
            f.status === "pending"
              ? `<span class="status ${Number(f.days_until) < 0 ? "status-overdue" : Number(f.days_until) === 0 ? "status-due" : "status-upcoming"}">${escapeHtml(dueLabel(Number(f.days_until)))}</span>`
              : `<span class="status status-unreachable">Unreachable</span>`
          }${f.attempts > 0 ? ` <span class="muted">No answer ×${escapeHtml(f.attempts)}</span>` : ""}</td>
          <td>${escapeHtml(f.notes || "")}</td>
        </tr>`
    )
    .join("");
  const followUpSection = `
    <section class="no-print">
      <div class="page-title-row">
        <h2>Follow-ups</h2>
        <a href="/follow-ups?q=${encodeURIComponent(client.phone || client.company || client.name)}&view=${openFollowUps.some((f) => f.status === "pending" && Number(f.days_until) <= 0) ? "due" : "upcoming"}" class="button small secondary">Open in Follow-ups</a>
      </div>
      ${
        followUpRows
          ? `<div class="table-wrap"><table class="data-table compact">
              <thead><tr><th>Type</th><th>Call on</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>${followUpRows}</tbody>
            </table></div>`
          : '<p class="muted">No follow-up scheduled.</p>'
      }
      <form method="post" action="/clients/${client.id}/follow-ups" class="filters follow-up-add">
        <select name="type">${optionsHtml(manualFollowUpTypes, "reorder")}</select>
        <input type="date" name="due_date" value="${escapeHtml(defaultFollowUpIso)}" required aria-label="Call on">
        <input type="text" name="notes" placeholder="Reason for the call (optional)">
        <button type="submit">+ Add follow-up</button>
      </form>
    </section>`;

  const margin = revenue - cost;
  const openDeliveries = counted.filter((o) => !["delivered", "returned"].includes(o.delivery_status || "not_shipped")).length;
  const lastOrder = counted[0]?.order_date;
  const firstOrder = counted[counted.length - 1]?.order_date;

  const productRows = [...productTotals.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(
      ([name, t]) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td class="num">${escapeHtml(t.orders.size)}</td>
          <td class="num">${escapeHtml(qty(t.kg))}</td>
          <td class="num">${escapeHtml(money(t.revenue))}</td>
          <td class="num">${escapeHtml(money(t.cost))}</td>
          <td class="num">${escapeHtml(money(t.revenue - t.cost))}</td>
        </tr>`
    )
    .join("");

  const orderCards = orders
    .map((o) => {
      const items = itemsByOrder.get(o.id) || [];
      const isSample = items.length > 0 && items.every((i) => Number(i.unit_price) === 0);
      const cancelled = o.status === "cancelled";
      let orderKg = 0;
      let orderCost = 0;
      const itemRows = items
        .map((i) => {
          const lineKg = Number(i.quantity_kg || 0);
          const lineAmount = lineKg * Number(i.unit_price || 0);
          const lineCost = lineKg * Number(i.cost_price || 0);
          orderKg += lineKg;
          orderCost += lineCost;
          return `
            <tr>
              <td>${escapeHtml(i.product_name)}${i.sku ? ` <span class="muted">(${escapeHtml(i.sku)})</span>` : ""}</td>
              <td class="num">${escapeHtml(qty(i.quantity_kg, 4))}</td>
              <td class="num">${escapeHtml(qty(i.quantity_sachets))}</td>
              <td class="num">${escapeHtml(qty(i.quantity_cartons))}</td>
              <td class="num">${escapeHtml(money(Number(i.unit_price)))}</td>
              <td class="num">${escapeHtml(money(lineAmount))}</td>
              <td class="num">${escapeHtml(money(lineCost))}</td>
              <td class="num">${escapeHtml(money(lineAmount - lineCost))}</td>
            </tr>`;
        })
        .join("");
      const orderValue = Number(o.order_value || 0);
      const canEdit = admin || o.user_id === currentUserId;
      const addressHtml = locationHtml(o.delivery_address || client.delivery_location);

      return `
        <article class="client-order${cancelled ? " is-cancelled" : ""}">
          <header class="client-order-header">
            <div>
              <h3>Order #${escapeHtml(o.id)} <span class="muted">· ${escapeHtml(shortDate(o.order_date))}</span></h3>
            </div>
            <div class="client-order-badges">
              ${isSample ? '<span class="badge">Sample</span>' : ""}
              <span class="status status-${escapeHtml(o.status)}">${escapeHtml(labelize(o.status))}</span>
              <span class="status status-${escapeHtml(o.delivery_status || "not_shipped")}">${escapeHtml(labelize(o.delivery_status || "not_shipped"))}</span>
            </div>
          </header>
          <dl class="client-order-meta">
            <div><dt>Salesperson</dt><dd>${escapeHtml(o.owner_name || "—")}</dd></div>
            <div><dt>Driver</dt><dd>${escapeHtml(o.driver_name || "—")}</dd></div>
            <div><dt>Delivery date</dt><dd>${escapeHtml(shortDate(o.delivery_date))}</dd></div>
            <div><dt>Address</dt><dd>${addressHtml}</dd></div>
          </dl>
          ${
            items.length
              ? `<div class="table-wrap">
                  <table class="data-table compact">
                    <thead><tr><th>Product</th><th class="num">Kg</th><th class="num">Sachets</th><th class="num">Cartons</th><th class="num">Unit price</th><th class="num">Amount</th><th class="num">Cost</th><th class="num">Margin</th></tr></thead>
                    <tbody>${itemRows}</tbody>
                    <tfoot><tr><td>Total</td><td class="num">${escapeHtml(qty(orderKg, 4))}</td><td></td><td></td><td></td><td class="num">${escapeHtml(money(orderValue))}</td><td class="num">${escapeHtml(money(orderCost))}</td><td class="num">${escapeHtml(money(orderValue - orderCost))}</td></tr></tfoot>
                  </table>
                </div>`
              : `<p class="muted">No product lines recorded. Order value: ${escapeHtml(money(orderValue))}</p>`
          }
          ${o.notes ? `<p class="client-order-notes"><strong>Notes:</strong> ${escapeHtml(o.notes)}</p>` : ""}
          ${canEdit ? `<div class="client-order-actions no-print"><a href="/orders/${o.id}/edit" class="button small secondary">Edit order</a></div>` : ""}
        </article>`;
    })
    .join("");

  res.send(
    renderPage(
      clientLabel(client),
      `
      <div class="page-title-row">
        <h1>${escapeHtml(client.company || client.name)}</h1>
        <div class="title-actions no-print">
          <a href="/orders/new?lead_id=${client.id}" class="button">+ New Order</a>
          <a href="/clients/${client.id}/export${range !== "all_time" ? `?range=${encodeURIComponent(range)}` : ""}" class="button secondary">Export CSV</a>
          <button type="button" class="button secondary" onclick="window.print()">Print</button>
          <a href="/clients" class="button secondary">← All clients</a>
        </div>
      </div>
      <section class="lead-summary">
        <p><strong>Contact:</strong> ${escapeHtml(client.name)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(client.phone) || "—"}</p>
        <p><strong>Email:</strong> ${escapeHtml(client.email) || "—"}</p>
        <p><strong>Region:</strong> ${escapeHtml(labelize(client.region))}</p>
        <p><strong>Salesperson:</strong> ${escapeHtml(client.owner_name) || "—"}</p>
        <p><strong>Lead status:</strong> <span class="status status-${escapeHtml(client.status)}">${escapeHtml(labelize(client.status))}</span></p>
        ${client.delivery_location ? `<p><strong>Delivery location:</strong> ${locationHtml(client.delivery_location)}</p>` : ""}
        ${client.notes ? `<p><strong>Notes:</strong> ${escapeHtml(client.notes)}</p>` : ""}
        <p class="no-print"><a href="/leads/${client.id}/edit">Edit client</a> · <a href="/leads/${client.id}/notes">Comments</a></p>
      </section>
      <section class="stats client-stats">
        <div class="card highlight"><strong>${escapeHtml(money(revenue))}</strong><span>Revenue (${escapeHtml(counted.length)} orders)</span></div>
        <div class="card"><strong>${escapeHtml(money(margin))}</strong><span>Margin${revenue > 0 ? ` (${escapeHtml(((margin / revenue) * 100).toFixed(1))}%)` : ""}</span></div>
        <div class="card"><strong>${escapeHtml(qty(kg))} kg</strong><span>Total quantity</span></div>
        <div class="card"><strong>${escapeHtml(money(counted.length ? revenue / counted.length : 0))}</strong><span>Average order</span></div>
        <div class="card"><strong>${escapeHtml(openDeliveries)}</strong><span>Open deliveries</span></div>
        <div class="card"><strong>${escapeHtml(shortDate(lastOrder))}</strong><span>Last order${firstOrder ? ` · first ${escapeHtml(shortDate(firstOrder))}` : ""}</span></div>
      </section>
      <div class="toolbar no-print">
        <form method="get" class="filters">
          <label>Period <select name="range">${optionsHtml(clientRangeOptions, range)}</select></label>
          <button type="submit">Update</button>
        </form>
      </div>
      ${followUpSection}
      ${
        productRows
          ? `<section>
              <h2>Products bought</h2>
              <div class="table-wrap">
                <table class="data-table compact">
                  <thead><tr><th>Product</th><th class="num">Orders</th><th class="num">Kg</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Margin</th></tr></thead>
                  <tbody>${productRows}</tbody>
                </table>
              </div>
            </section>`
          : ""
      }
      <section>
        <h2>Transactions (${escapeHtml(orders.length)})</h2>
        ${orderCards || '<p class="empty">No orders for this client in the selected period.</p>'}
      </section>
      <p class="hint">Totals exclude cancelled orders. Cost and margin use each product's current cost price.</p>`,
      req
    )
  );
});

app.get("/clients/:id/export", requireAuth, blockDriver, async (req, res) => {
  const history = await loadClientHistory(req, res);
  if (!history) return;
  const { client, orders, itemsByOrder } = history;
  const lines = [
    csvRow(["Order ID", "Order date", "Status", "Delivery status", "Delivery date", "Product", "SKU", "Kg", "Sachets", "Cartons", "Unit price", "Amount", "Cost", "Margin", "Salesperson", "Driver", "Notes"]),
  ];
  for (const o of orders) {
    const base = [o.id, localIso(new Date(o.order_date)), o.status, o.delivery_status, o.delivery_date ? new Date(o.delivery_date).toISOString() : ""];
    const tail = [o.owner_name, o.driver_name, o.notes];
    const items = itemsByOrder.get(o.id) || [];
    if (!items.length) {
      lines.push(csvRow([...base, "", "", "", "", "", "", Number(o.order_value || 0).toFixed(2), "", "", ...tail]));
      continue;
    }
    for (const i of items) {
      const lineKg = Number(i.quantity_kg || 0);
      const amount = lineKg * Number(i.unit_price || 0);
      const lineCost = lineKg * Number(i.cost_price || 0);
      lines.push(
        csvRow([
          ...base,
          i.product_name,
          i.sku,
          lineKg,
          Number(i.quantity_sachets || 0),
          Number(i.quantity_cartons || 0),
          Number(i.unit_price || 0).toFixed(2),
          amount.toFixed(2),
          lineCost.toFixed(2),
          (amount - lineCost).toFixed(2),
          ...tail,
        ])
      );
    }
  }
  const fileName = (client.company || client.name).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "client";
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${fileName}-transactions.csv`);
  res.send(lines.join("\n"));
});

const followUpTypes = [
  { value: "sample_feedback", label: "Sample feedback" },
  { value: "reorder", label: "Next order" },
  { value: "no_recent_order", label: `No order in ${INACTIVE_CLIENT_DAYS}+ days` },
  { value: "other", label: "Other" },
];

const followUpOutcomes: Record<string, { label: string; sampleOnly?: boolean }> = {
  no_answer: { label: "No answer" },
  call_back: { label: "Not ready yet / call back later" },
  placed_order: { label: "Placed an order" },
  liked_sample: { label: "Liked the sample", sampleOnly: true },
  disliked_sample: { label: "Didn't like the sample", sampleOnly: true },
  not_interested: { label: "Not interested" },
};

const followUpViews = ["due", "upcoming", "unreachable", "done"] as const;
type FollowUpView = (typeof followUpViews)[number];

const manualFollowUpTypes = followUpTypes.filter((t) => t.value !== "no_recent_order");

function followUpTypeLabel(type: string): string {
  return followUpTypes.find((t) => t.value === type)?.label || labelize(type);
}

function followUpTypeBadge(type: string): string {
  return `<span class="badge${type === "no_recent_order" ? " badge-danger" : ""}">${escapeHtml(followUpTypeLabel(type))}</span>`;
}

function noRecentOrderLabel(daysSinceOrder: number | string | null | undefined): string {
  if (daysSinceOrder === null || daysSinceOrder === undefined) return "";
  const days = Number(daysSinceOrder);
  return days >= INACTIVE_CLIENT_DAYS ? `<span class="status status-overdue">No order for ${escapeHtml(days)} days</span>` : "";
}

function followUpOutcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "—";
  return followUpOutcomes[outcome]?.label || labelize(outcome);
}

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value;
}

function isoDateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function dueLabel(daysUntil: number): string {
  if (daysUntil < 0) return `Overdue ${-daysUntil} day${daysUntil === -1 ? "" : "s"}`;
  if (daysUntil === 0) return "Due today";
  if (daysUntil === 1) return "Tomorrow";
  return `In ${daysUntil} days`;
}

function whatsappNumber(phone: string | null | undefined): string | null {
  let digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 8) digits = `230${digits}`;
  return digits.length >= 10 ? digits : null;
}

function safeReturnTo(value: unknown, fallback = "/follow-ups"): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

interface FollowUpFilters {
  view?: string;
  type?: string;
  owner?: string;
  q?: string;
}

async function followUpBaseWhere(req: Request, filters: FollowUpFilters) {
  const leadF = await leadFilter(req, "l");
  const params: (string | number | undefined)[] = [...leadF.params];
  let where = `WHERE 1=1${leadF.where}`;
  if (filters.type && followUpTypes.some((t) => t.value === filters.type)) {
    params.push(filters.type);
    where += ` AND f.type = $${params.length}`;
  }
  const ownerId = parseInt(filters.owner || "", 10);
  if (ownerId && isAdmin(req)) {
    params.push(ownerId);
    where += ` AND l.assigned_to = $${params.length}`;
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const p = `$${params.length}`;
    where += ` AND (l.name ILIKE ${p} OR l.company ILIKE ${p} OR l.phone ILIKE ${p})`;
  }
  return { where, params };
}

const followUpViewSql: Record<FollowUpView, { where: string; orderBy: string }> = {
  due: { where: "f.status = 'pending' AND f.due_date <= CURRENT_DATE", orderBy: "f.due_date ASC, f.id ASC" },
  upcoming: { where: "f.status = 'pending' AND f.due_date > CURRENT_DATE", orderBy: "f.due_date ASC, f.id ASC" },
  unreachable: { where: "f.status = 'unreachable'", orderBy: "f.updated_at DESC" },
  done: { where: "f.status IN ('done', 'cancelled')", orderBy: "COALESCE(f.completed_at, f.updated_at) DESC" },
};

function followUpCard(f: any, admin: boolean, returnTo: string): string {
  const daysUntil = Number(f.days_until);
  const pending = f.status === "pending";
  const overdue = pending && daysUntil < 0;
  const isSampleType = f.type === "sample_feedback";
  const wa = whatsappNumber(f.phone);
  const outcomeOptions = Object.entries(followUpOutcomes)
    .filter(([, o]) => !o.sampleOnly || isSampleType)
    .map(([value, o]) => ({ value, label: o.label }));

  const orderContext = f.order_id
    ? `<p><strong>${isSampleType ? "Sample" : "Order"} #${escapeHtml(f.order_id)}</strong>${
        f.order_date ? ` · ordered ${escapeHtml(shortDate(f.order_date))}` : ""
      }${f.order_summary ? ` · ${escapeHtml(f.order_summary)}` : ""}${
        !isSampleType && Number(f.order_value) > 0 ? ` · ${escapeHtml(money(Number(f.order_value)))}` : ""
      }</p>`
    : "";
  const avgGap = f.avg_gap !== null && f.avg_gap !== undefined ? Math.round(Number(f.avg_gap)) : null;
  const rhythm =
    Number(f.order_count) > 0
      ? `<p class="muted">${escapeHtml(f.order_count)} paid order${Number(f.order_count) === 1 ? "" : "s"}${
          avgGap ? ` · usually orders every ~${escapeHtml(avgGap)} days` : ""
        } · last order ${escapeHtml(shortDate(f.last_order))}</p>`
      : `<p class="muted">No paid orders yet</p>`;

  let actions = "";
  if (pending) {
    actions = `
      <form method="post" action="/follow-ups/${f.id}/reschedule" class="follow-up-reschedule">
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
        <span class="muted">Move to:</span>
        <button type="submit" name="days" value="1" class="button small secondary">+1 day</button>
        <button type="submit" name="days" value="3" class="button small secondary">+3 days</button>
        <button type="submit" name="days" value="7" class="button small secondary">+1 week</button>
        <input type="date" name="due_date" value="${escapeHtml(f.due_iso)}" aria-label="Follow-up date">
        <button type="submit" class="button small secondary">Set date</button>
      </form>
      <details class="follow-up-log">
        <summary class="button small">Log call</summary>
        <form method="post" action="/follow-ups/${f.id}/log" class="form-grid">
          <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
          <label>Outcome
            <select name="outcome" required>${optionsHtml([{ value: "", label: "Choose..." }, ...outcomeOptions], "")}</select>
          </label>
          <label>Next call date <span class="muted">(optional)</span>
            <input type="date" name="next_date">
          </label>
          <label class="full">Note<textarea name="note" rows="2" placeholder="What did they say?"></textarea></label>
          <p class="hint full">No answer: tries again tomorrow, and after ${MAX_NO_ANSWER_ATTEMPTS} tries the follow-up is marked unreachable. Call back / liked the sample: next call in ${DEFAULT_FOLLOW_UP_DAYS} days unless you pick a date. Placed an order: opens a new order for this client.</p>
          <div class="actions full"><button type="submit">Save call</button></div>
        </form>
      </details>
      <form method="post" action="/follow-ups/${f.id}/cancel" class="inline-form" onsubmit="return confirm('Cancel this follow-up?');">
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
        <button type="submit" class="button small danger">Cancel</button>
      </form>`;
  } else {
    actions = `
      <form method="post" action="/follow-ups/${f.id}/reopen" class="follow-up-reschedule">
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
        <input type="date" name="due_date" aria-label="New follow-up date">
        <button type="submit" class="button small secondary">Reopen</button>
      </form>`;
  }

  const statusBadge = pending
    ? `<span class="status ${overdue ? "status-overdue" : daysUntil === 0 ? "status-due" : "status-upcoming"}">${escapeHtml(dueLabel(daysUntil))}</span>`
    : `<span class="status status-${escapeHtml(f.status)}">${escapeHtml(labelize(f.status))}</span>`;

  return `
    <article class="follow-up-card${overdue ? " is-overdue" : ""}">
      <header class="client-order-header">
        <div>
          <h3><a href="/clients/${f.lead_id}">${escapeHtml(f.company || f.name)}</a></h3>
          <span class="muted">${escapeHtml(f.company ? f.name : "")}${f.company && f.region ? " · " : ""}${escapeHtml(f.region ? labelize(f.region) : "")}${
            admin && f.owner_name ? ` · ${escapeHtml(f.owner_name)}` : ""
          }</span>
        </div>
        <div class="client-order-badges">
          ${followUpTypeBadge(f.type)}
          ${noRecentOrderLabel(f.days_since_order)}
          ${statusBadge}
          ${f.attempts > 0 ? `<span class="badge">No answer ×${escapeHtml(f.attempts)}</span>` : ""}
        </div>
      </header>
      <div class="follow-up-body">
        <p class="follow-up-contact">
          ${f.phone ? `<a href="tel:${escapeHtml(f.phone.replace(/[^\d+]/g, ""))}" class="button small">📞 ${escapeHtml(f.phone)}</a>` : '<span class="muted">No phone number</span>'}
          ${wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer" class="button small secondary">WhatsApp</a>` : ""}
          <span class="muted">${pending ? `Call on ${escapeHtml(isoDateLabel(f.due_iso))}` : ""}</span>
        </p>
        ${orderContext}
        ${rhythm}
        ${f.notes ? `<p><strong>Note:</strong> ${escapeHtml(f.notes)}</p>` : ""}
        ${
          !pending
            ? `<p class="muted">${f.outcome ? `Outcome: ${escapeHtml(followUpOutcomeLabel(f.outcome))}` : ""}${
                f.completed_at ? ` · ${escapeHtml(shortDate(f.completed_at))}` : ""
              }${f.completed_by_name ? ` by ${escapeHtml(f.completed_by_name)}` : ""}</p>`
            : ""
        }
        ${
          f.last_comment
            ? `<p class="follow-up-last-comment"><span class="muted">Last comment (${escapeHtml(shortDate(f.last_comment_at))}):</span> ${escapeHtml(f.last_comment)} <a href="/leads/${f.lead_id}/notes" class="no-print">All comments</a></p>`
            : ""
        }
      </div>
      <div class="follow-up-actions no-print">${actions}</div>
    </article>`;
}

app.get("/follow-ups", requireAuth, blockDriver, async (req, res) => {
  const filters = req.query as FollowUpFilters;
  const view: FollowUpView = followUpViews.includes(filters.view as FollowUpView) ? (filters.view as FollowUpView) : "due";
  const admin = isAdmin(req);
  try {
    await syncInactiveClientFollowUps();
  } catch (err) {
    console.error("Could not sync inactive-client follow-ups", err);
  }
  const base = await followUpBaseWhere(req, filters);

  const countsResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE f.type = 'no_recent_order' AND f.status = 'pending')::int AS inactive,
       COUNT(*) FILTER (WHERE ${followUpViewSql.due.where})::int AS due,
       COUNT(*) FILTER (WHERE ${followUpViewSql.upcoming.where})::int AS upcoming,
       COUNT(*) FILTER (WHERE ${followUpViewSql.unreachable.where})::int AS unreachable,
       COUNT(*) FILTER (WHERE f.status = 'pending' AND f.due_date < CURRENT_DATE)::int AS overdue
     FROM follow_ups f JOIN leads l ON l.id = f.lead_id
     ${base.where}`,
    base.params
  );
  const counts = countsResult.rows[0];

  const viewSql = followUpViewSql[view];
  const result = await pool.query(
    `SELECT f.*, to_char(f.due_date, 'YYYY-MM-DD') AS due_iso, (f.due_date - CURRENT_DATE) AS days_until,
            l.name, l.company, l.phone, l.region, owner.name AS owner_name, completer.name AS completed_by_name,
            o.order_date, o.order_value,
            (SELECT string_agg(p.name || ' ' || trim(to_char(oi.quantity_kg, 'FM999999990.###')) || ' kg', ', ' ORDER BY oi.id)
               FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = f.order_id) AS order_summary,
            stats.order_count, stats.last_order, stats.avg_gap, stats.days_since_order,
            lc.comment AS last_comment, lc.created_at AS last_comment_at
     FROM follow_ups f
     JOIN leads l ON l.id = f.lead_id
     LEFT JOIN users owner ON owner.id = l.assigned_to
     LEFT JOIN users completer ON completer.id = f.completed_by
     LEFT JOIN orders o ON o.id = f.order_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE NOT x.is_sample)::int AS order_count,
              MAX(x.order_date) FILTER (WHERE NOT x.is_sample) AS last_order,
              CASE WHEN COUNT(*) FILTER (WHERE NOT x.is_sample) > 1
                THEN (MAX(x.order_date) FILTER (WHERE NOT x.is_sample) - MIN(x.order_date) FILTER (WHERE NOT x.is_sample))::numeric
                     / (COUNT(*) FILTER (WHERE NOT x.is_sample) - 1)
              END AS avg_gap,
              CURRENT_DATE - MAX(x.order_date) AS days_since_order
       FROM (
         SELECT o.order_date, ${SAMPLE_ORDER_SQL} AS is_sample
         FROM orders o
         WHERE o.lead_id = l.id AND o.status != 'cancelled'
       ) x
     ) stats ON true
     LEFT JOIN LATERAL (
       SELECT comment, created_at FROM lead_comments WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1
     ) lc ON true
     ${base.where} AND ${viewSql.where}
     ORDER BY ${viewSql.orderBy}
     LIMIT 200`,
    base.params
  );

  const owners = admin
    ? (await pool.query("SELECT id, name FROM users WHERE role != 'driver' ORDER BY name")).rows
    : [];
  const returnTo = req.originalUrl;
  const tabQuery = (v: FollowUpView) => {
    const q = new URLSearchParams();
    q.set("view", v);
    if (filters.type) q.set("type", filters.type);
    if (filters.owner) q.set("owner", filters.owner);
    if (filters.q) q.set("q", filters.q);
    return `/follow-ups?${q.toString()}`;
  };
  const tabs: { view: FollowUpView; label: string; count?: number }[] = [
    { view: "due", label: "To call now", count: counts.due },
    { view: "upcoming", label: "Upcoming", count: counts.upcoming },
    { view: "unreachable", label: "Unreachable", count: counts.unreachable },
    { view: "done", label: "Done" },
  ];
  const emptyText: Record<FollowUpView, string> = {
    due: "Nothing to call today. 🎉",
    upcoming: "No upcoming follow-ups.",
    unreachable: "No unreachable clients.",
    done: "No completed follow-ups yet.",
  };

  res.send(
    renderPage(
      "Follow-ups",
      `
      <div class="page-title-row">
        <h1>📞 Follow-ups</h1>
      </div>
      <section class="stats">
        <div class="card highlight"><strong>${escapeHtml(counts.due)}</strong><span>To call now</span></div>
        <div class="card"><strong>${escapeHtml(counts.overdue)}</strong><span>Overdue</span></div>
        <div class="card"><strong>${escapeHtml(counts.upcoming)}</strong><span>Upcoming</span></div>
        <div class="card"><strong>${escapeHtml(counts.unreachable)}</strong><span>Unreachable</span></div>
        <a href="${escapeHtml(`/follow-ups?view=due&type=no_recent_order`)}" class="card card-danger"><strong>${escapeHtml(counts.inactive)}</strong><span>No order in ${INACTIVE_CLIENT_DAYS}+ days</span></a>
      </section>
      <nav class="tabs">
        ${tabs
          .map(
            (t) =>
              `<a href="${escapeHtml(tabQuery(t.view))}" class="tab${t.view === view ? " active" : ""}">${escapeHtml(t.label)}${
                t.count !== undefined ? ` <span class="tab-count">${escapeHtml(t.count)}</span>` : ""
              }</a>`
          )
          .join("")}
      </nav>
      <div class="toolbar">
        <form method="get" class="filters">
          <input type="hidden" name="view" value="${escapeHtml(view)}">
          <input type="search" name="q" value="${escapeHtml(filters.q || "")}" placeholder="Search client or phone...">
          <select name="type">${optionsHtml([{ value: "", label: "All types" }, ...followUpTypes], filters.type || "")}</select>
          ${
            admin
              ? `<select name="owner">${optionsHtml(
                  [{ value: "", label: "All salespeople" }, ...owners.map((u) => ({ value: String(u.id), label: u.name }))],
                  filters.owner || ""
                )}</select>`
              : ""
          }
          <button type="submit">Filter</button>
        </form>
      </div>
      ${
        result.rows.length
          ? result.rows.map((f) => followUpCard(f, admin, returnTo)).join("")
          : `<p class="empty">${escapeHtml(emptyText[view])}</p>`
      }
      <p class="hint">Follow-ups are created automatically ${DEFAULT_FOLLOW_UP_DAYS} days after an order is delivered: samples get a "Sample feedback" call, other orders a "Next order" call. Clients whose last order is ${INACTIVE_CLIENT_DAYS} or more days old get a red "No order" call for today. You can add one by hand from a client's page.</p>`,
      req
    )
  );
});

async function loadFollowUpForAction(req: Request, res: Response) {
  const id = parseInt(req.params.id, 10);
  if (!id || !(await canAccessFollowUp(req, id))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return null;
  }
  const result = await pool.query("SELECT * FROM follow_ups WHERE id = $1", [id]);
  return result.rows[0] as { id: number; lead_id: number; order_id: number | null; type: string; status: string; attempts: number };
}

app.post("/follow-ups/:id/reschedule", requireAuth, blockDriver, async (req, res) => {
  const followUp = await loadFollowUpForAction(req, res);
  if (!followUp) return;
  const returnTo = safeReturnTo(req.body.return_to);
  const days = parseInt(req.body.days, 10);
  const date = parseIsoDate(req.body.due_date);
  let result;
  if (days >= 1 && days <= 365) {
    result = await pool.query(
      `UPDATE follow_ups SET due_date = GREATEST(due_date, CURRENT_DATE) + $2::int, status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
      [followUp.id, days]
    );
  } else if (date) {
    result = await pool.query(
      `UPDATE follow_ups SET due_date = $2::date, status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
      [followUp.id, date]
    );
  } else {
    setFlash(req, "Pick a date for the follow-up", "error");
    res.redirect(returnTo);
    return;
  }
  setFlash(req, `Follow-up moved to ${isoDateLabel(result.rows[0].due_iso)}`);
  res.redirect(returnTo);
});

app.post("/follow-ups/:id/log", requireAuth, blockDriver, async (req, res) => {
  const followUp = await loadFollowUpForAction(req, res);
  if (!followUp) return;
  const returnTo = safeReturnTo(req.body.return_to);
  const outcome = String(req.body.outcome || "");
  if (!followUpOutcomes[outcome]) {
    setFlash(req, "Choose the outcome of the call", "error");
    res.redirect(returnTo);
    return;
  }
  const note = String(req.body.note || "").trim();
  const nextDate = parseIsoDate(req.body.next_date);
  const userId = req.session.user!.id;
  let message: string;

  if (outcome === "no_answer") {
    const attempts = followUp.attempts + 1;
    if (attempts >= MAX_NO_ANSWER_ATTEMPTS && !nextDate) {
      await pool.query(
        `UPDATE follow_ups SET attempts = $2, outcome = 'no_answer', status = 'unreachable', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [followUp.id, attempts]
      );
      message = `No answer ${attempts} times. Moved to Unreachable.`;
    } else {
      const r = await pool.query(
        `UPDATE follow_ups SET attempts = $2, outcome = 'no_answer', due_date = COALESCE($3::date, CURRENT_DATE + 1), updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
        [followUp.id, attempts, nextDate]
      );
      message = `No answer (try ${attempts} of ${MAX_NO_ANSWER_ATTEMPTS}). Next try ${isoDateLabel(r.rows[0].due_iso)}.`;
    }
  } else if (outcome === "call_back") {
    const r = await pool.query(
      `UPDATE follow_ups SET attempts = 0, outcome = 'call_back', due_date = COALESCE($2::date, CURRENT_DATE + $3::int), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
      [followUp.id, nextDate, DEFAULT_FOLLOW_UP_DAYS]
    );
    message = `Next call ${isoDateLabel(r.rows[0].due_iso)}.`;
  } else {
    await pool.query(
      `UPDATE follow_ups SET status = 'done', outcome = $2, completed_by = $3, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [followUp.id, outcome, userId]
    );
    message = `Call saved: ${followUpOutcomeLabel(outcome)}.`;
    const nextFollowUpDate = outcome === "liked_sample" ? nextDate || "default" : outcome === "placed_order" ? null : nextDate;
    if (nextFollowUpDate) {
      const r = await pool.query(
        `INSERT INTO follow_ups (lead_id, type, due_date, notes, created_by)
         VALUES ($1, 'reorder', COALESCE($2::date, CURRENT_DATE + $3::int), $4, $5)
         RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
        [
          followUp.lead_id,
          nextFollowUpDate === "default" ? null : nextFollowUpDate,
          DEFAULT_FOLLOW_UP_DAYS,
          `After call: ${followUpOutcomeLabel(outcome)}`,
          userId,
        ]
      );
      message += ` Next order call ${isoDateLabel(r.rows[0].due_iso)}.`;
    }
  }

  await pool.query("INSERT INTO lead_comments (lead_id, user_id, comment) VALUES ($1, $2, $3)", [
    followUp.lead_id,
    userId,
    `Follow-up call (${followUpTypeLabel(followUp.type)}): ${followUpOutcomeLabel(outcome)}${note ? `. ${note}` : ""}`,
  ]);
  await pool.query("UPDATE leads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [followUp.lead_id]);

  setFlash(req, message);
  res.redirect(outcome === "placed_order" ? `/orders/new?lead_id=${followUp.lead_id}` : returnTo);
});

app.post("/follow-ups/:id/cancel", requireAuth, blockDriver, async (req, res) => {
  const followUp = await loadFollowUpForAction(req, res);
  if (!followUp) return;
  await pool.query(
    `UPDATE follow_ups SET status = 'cancelled', completed_by = $2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [followUp.id, req.session.user!.id]
  );
  setFlash(req, "Follow-up cancelled");
  res.redirect(safeReturnTo(req.body.return_to));
});

app.post("/follow-ups/:id/reopen", requireAuth, blockDriver, async (req, res) => {
  const followUp = await loadFollowUpForAction(req, res);
  if (!followUp) return;
  const date = parseIsoDate(req.body.due_date);
  let r;
  try {
    r = await pool.query(
      `UPDATE follow_ups
       SET status = 'pending', attempts = 0, completed_by = NULL, completed_at = NULL,
           due_date = COALESCE($2::date, GREATEST(due_date, CURRENT_DATE)), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
      [followUp.id, date]
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    setFlash(req, "This client already has an open follow-up of this type", "error");
    res.redirect(safeReturnTo(req.body.return_to));
    return;
  }
  setFlash(req, `Follow-up reopened for ${isoDateLabel(r.rows[0].due_iso)}`);
  res.redirect(safeReturnTo(req.body.return_to));
});

app.post("/clients/:id/follow-ups", requireAuth, blockDriver, async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  if (!leadId || !(await canAccessLead(req, leadId))) {
    res.status(403).send(renderPage("Access Denied", "<h1>Access Denied</h1>", req));
    return;
  }
  const type = manualFollowUpTypes.some((t) => t.value === req.body.type) ? req.body.type : "other";
  const date = parseIsoDate(req.body.due_date);
  const notes = String(req.body.notes || "").trim() || null;
  const r = await pool.query(
    `INSERT INTO follow_ups (lead_id, type, due_date, notes, created_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE + $4::int), $5, $6)
     RETURNING to_char(due_date, 'YYYY-MM-DD') AS due_iso`,
    [leadId, type, date, DEFAULT_FOLLOW_UP_DAYS, notes, req.session.user!.id]
  );
  setFlash(req, `Follow-up added for ${isoDateLabel(r.rows[0].due_iso)}`);
  res.redirect(safeReturnTo(req.body.return_to, `/clients/${leadId}`));
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

