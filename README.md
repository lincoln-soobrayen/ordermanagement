# Leads & Orders Tracker

A simple web app for tracking sales leads and orders. Built with Node.js, Express, TypeScript, and PostgreSQL.

## Features

- User login with session-based authentication
- Dashboard with pipeline value, order value, and status breakdowns
- Leads management: create, edit, delete, search, filter by status
- Orders management: create, edit, delete, link to a lead, search, filter by status
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

   Change the default password from **Users** after logging in, or use the **Forgot password?** link if SMTP is configured.

## Password reset email

To send password-reset links by email, set these variables in `.env`:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=noreply@example.com
PASSWORD_RESET_URL_BASE=http://localhost:3000
```

If SMTP is not configured, reset links are printed to the console so you can still test the flow locally.

## Sharing on a network

Once the app is running on a computer, other people on the same network can access it using the host computer's IP address:

```
http://192.168.x.x:3000
```

## Project structure

```
src/
  db.ts          # PostgreSQL pool, schema, and types
  auth.ts        # Password hashing and login helpers
  views.ts       # HTML rendering helpers
  server.ts      # Express routes and app logic
public/
  style.css      # App styles
  app.js         # Small frontend helpers
```

## License

ISC
