# Leads & Orders Tracker — Implementation Plan

## Goal
Build a simple, self-hosted web app that lets a small team track sales leads and orders on a shared network.

## Tech Stack
- **Runtime:** Node.js with Express (TypeScript)
- **Database:** PostgreSQL (as requested)
- **Frontend:** Server-rendered HTML + vanilla JavaScript (no heavy framework)
- **Auth:** Simple session-based login (user accounts table)
- **Styling:** Plain CSS, mobile-friendly layout

## Data Model
- **users** — id, email, password_hash, name, created_at
- **leads** — id, name, company, email, phone, status (new / contacted / qualified / converted / lost), value, notes, assigned_to, created_at, updated_at
- **orders** — id, lead_id (optional), customer_name, order_value, status (pending / confirmed / shipped / completed / cancelled), order_date, notes, created_at, updated_at

## Features
1. **Authentication** — login/logout, basic user accounts
2. **Dashboard** — counts of leads and orders by status, total pipeline value, recent activity
3. **Leads CRUD** — list, create, edit, delete, search/filter by status/name
4. **Orders CRUD** — list, create, edit, delete, link to a lead, search/filter
5. **Status Tracking** — status dropdowns on leads and orders
6. **CSV Export** — export leads and orders to CSV
7. **Simple Reports** — conversion funnel view, monthly order totals

## Project Structure
```
/
├── src/
│   ├── db.ts              # PostgreSQL connection & migrations
│   ├── server.ts          # Express app & routes
│   ├── auth.ts            # session/password helpers
│   └── views.ts           # HTML view helpers
├── public/
│   ├── app.js             # frontend interactivity
│   └── style.css          # styles
├── package.json
├── tsconfig.json
└── .env.example
```

## First Steps
1. Initialize Node/TypeScript project and install dependencies
2. Create PostgreSQL schema and seed sample data
3. Implement auth + dashboard
4. Implement leads and orders CRUD + CSV export
5. Add reports page

## Notes
- The app will run on `http://localhost:3000` by default and be accessible to anyone on the same network via the host's IP address.
- The user requested PostgreSQL ("postgress" in the answers); this plan uses it.
