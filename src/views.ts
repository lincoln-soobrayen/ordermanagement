export function page(title: string, body: string, userName?: string, isAdmin: boolean = false, isDriver: boolean = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Leads & Orders</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  ${userName ? sideMenu(userName, isAdmin, isDriver) : ""}
  <div class="app-shell ${userName ? "with-sidebar" : ""}">
    ${userName ? "" : `<header class="site-header"><div class="container"><a href="/" class="logo">Leads & Orders</a></div></header>`}
    <main class="main-content">
      ${body}
    </main>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
}

function sideMenu(userName: string, isAdmin: boolean, isDriver: boolean): string {
  const baseItems = isDriver
    ? [{ href: "/deliveries", icon: "🚚", label: "Deliveries" }]
    : [
        { href: "/dashboard", icon: "⊞", label: "Dashboard" },
        { href: "/leads", icon: "👤", label: "Leads" },
        { href: "/clients", icon: "🏢", label: "Clients" },
        { href: "/orders", icon: "📦", label: "Orders" },
        { href: "/deliveries", icon: "🚚", label: "Deliveries" },
        { href: "/products", icon: "🛍", label: "Products" },
        ...(isAdmin ? [{ href: "/users", icon: "⚙", label: "Users" }] : []),
      ];

  const renderItem = (i: { href: string; icon: string; label: string }) => `
    <a href="${i.href}" class="sidebar-link" data-match="${i.href}">
      <span class="sidebar-icon">${i.icon}</span>
      <span class="sidebar-label">${escapeHtml(i.label)}</span>
    </a>
  `;

  const reportsMenu = `
    <div class="sidebar-group">
      <a href="/reports" class="sidebar-link" data-match="/reports">
        <span class="sidebar-icon">📊</span>
        <span class="sidebar-label">Reports</span>
        <span class="sidebar-chevron">▾</span>
      </a>
      <div class="sidebar-submenu">
        ${renderItem({ href: "/reports", icon: "📊", label: "Overview" })}
        ${renderItem({ href: "/reports/kg-sales", icon: "📈", label: "KG Sales" })}
        ${renderItem({ href: "/reports/monthly-margin", icon: "💰", label: "Monthly Margin" })}
        ${renderItem({ href: "/reports/client-margin", icon: "📉", label: "Client Margin" })}
      </div>
    </div>
  `;

  return `
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
      <a href="/" class="logo">Leads & Orders</a>
      <button type="button" class="sidebar-close" id="sidebar-close" aria-label="Close menu">✕</button>
    </div>
    <nav class="sidebar-nav">
      ${baseItems.map(renderItem).join("")}
      ${reportsMenu}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <span class="sidebar-user-avatar">${escapeHtml(userName.charAt(0).toUpperCase())}</span>
        <span class="sidebar-user-name">${escapeHtml(userName)}</span>
      </div>
      <form method="post" action="/logout">
        <button type="submit" class="sidebar-logout">Logout</button>
      </form>
    </div>
  </aside>
  <div class="sidebar-overlay" id="sidebar-overlay"></div>
  <header class="top-bar">
    <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open menu">☰</button>
    <span class="top-bar-title">Leads & Orders</span>
  </header>`;
}

export function escapeHtml(input: string | null | undefined | number): string {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function alertHtml(message: string, type: "success" | "error" = "success"): string {
  return `<div class="alert alert-${type}">${escapeHtml(message)}</div>`;
}

export function statusOptions(selected: string, statuses: string[]): string {
  return statuses
    .map(
      (s) =>
        `<option value="${escapeHtml(s)}" ${s === selected ? "selected" : ""}>${escapeHtml(
          s.charAt(0).toUpperCase() + s.slice(1)
        )}</option>`
    )
    .join("");
}
