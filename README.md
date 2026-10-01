# Leads & Orders Tracker

A simple web app for tracking sales leads and orders. Built with Node.js, Express, TypeScript, and PostgreSQL.

## Features

- User login with session-based authentication
- Dashboard with pipeline value, order value, and status breakdowns
- Leads management: create, edit, delete, search, filter by status
- Orders management: create, edit, delete, link to a lead, search, filter by status
- Clients: every client with their full order history, products bought, and margin
- Follow-ups: call list created automatically 3 days after each delivery (sample feedback or next order), with no-answer retries and editable call dates
- CSV export for leads and orders
- Simple reports: conversion funnel and monthly revenue

## Requirements

- [Node.js](https://nodejs.org/) (v18 or later)
- [PostgreSQL](https://www.postgresql.org/) (v13 or later)

## Setup

1. **Create the database**

   ```bash
   createdb aurifla_leads_orders
   ```

2. **Configure environment variables**

   Copy the example file and edit it with your database credentials:

   ```bash
   cp .env.example .env
   ```

   Example `.env`:

   ```env
   PORT=3000
   DATABASE_URL=postgresql://username:password@localhost:5432/aurifla_leads_orders
   SESSION_SECRET=replace-with-a-long-random-string
   ```

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Run the app**

   Development mode (auto-reloads on changes):

   ```bash
   npm run dev
   ```

   Production build:

   ```bash
   npm run build
   npm start
   ```

5. **Open in browser**

   Go to `http://localhost:3000` and sign in. The default admin account is created automatically on first run:

   - Email: `admin@example.com`
   - Password: `admin123`

   Change the default password from **Users** after logging in.

## Password resets

Email is not configured. When an admin clicks **Send reset link** on the **Users** page, the link is shown on screen to copy and share. Self-service "Forgot password?" links are only written to the logs (`npx wrangler tail` in production).

## Production deployment (Cloudflare + Mac mini)

The app runs on Cloudflare Workers at https://ordermanagement.soobrayen.com. The PostgreSQL database stays on the Mac mini and is reached through Hyperdrive:

```
Worker (placed near JNB) -> Hyperdrive "ordermanagement-db" -> Workers VPC service -> Tunnel "ordermanagement-db" -> Postgres 16 on 127.0.0.1:5432
```

- Database: `ordermanagement` (role `ordermanagement`), credentials in `.env`.
- Tunnel: `~/.cloudflared/ordermanagement-db.yml`, run by the launchd agent `com.cloudflare.cloudflared.ordermanagement-db` (must use QUIC; it is separate from the shared `mac-server` tunnel).
- Postgres has `ssl = on` with a self-signed certificate; Hyperdrive requires TLS.
- Backups: `~/Backups/ordermanagement/backup.sh` runs daily at 02:30 (launchd agent `com.lincoln.ordermanagement-backup`) and keeps 30 days in `~/Backups/ordermanagement/dumps/`.

Schema changes are not applied by the Worker. After changing `initDb` in `src/db.ts`, run on the Mac mini:

```bash
npm run migrate
npm run deploy
```

## Project structure

```
src/
  app.ts         # Express routes and app logic
  db.ts          # PostgreSQL pool, schema, and types
  auth.ts        # Password hashing and login helpers
  views.ts       # HTML rendering helpers
  server.ts      # Local Node.js entry point (npm run dev)
  worker.ts      # Cloudflare Workers entry point
  migrate.ts     # Applies the schema (npm run migrate)
public/
  style.css      # App styles
  app.js         # Small frontend helpers
```

## License

ISC
