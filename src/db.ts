import { Pool } from "pg";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString: databaseUrl,
});

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'salesperson',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        company VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'new',
        value DECIMAL(12, 2) DEFAULT 0,
        delivery_location TEXT,
        notes TEXT,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        order_value DECIMAL(12, 2) NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        order_date DATE NOT NULL DEFAULT CURRENT_DATE,
        delivery_status VARCHAR(50) DEFAULT 'not_shipped',
        delivery_address TEXT,
        shipped_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(50) DEFAULT 'not_shipped',
      ADD COLUMN IF NOT EXISTS delivery_address TEXT,
      ADD COLUMN IF NOT EXISTS shipped_date DATE,
      ADD COLUMN IF NOT EXISTS delivery_date TIMESTAMP
    `);

    await client.query(`
      ALTER TABLE orders
      ALTER COLUMN status SET DEFAULT 'order_placed',
      ALTER COLUMN order_date SET DEFAULT CURRENT_DATE
    `);

    await client.query(`
      ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS delivery_location TEXT
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_comments (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        sku VARCHAR(255),
        description TEXT,
        cost_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
        selling_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
        stock_kg DECIMAL(12, 2) NOT NULL DEFAULT 0,
        kg_per_sachet DECIMAL(12, 4) NOT NULL DEFAULT 1,
        sachets_per_carton DECIMAL(12, 2) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS cost_price DECIMAL(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS selling_price DECIMAL(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS stock_kg DECIMAL(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS kg_per_sachet DECIMAL(12, 4) DEFAULT 1,
      ADD COLUMN IF NOT EXISTS sachets_per_carton DECIMAL(12, 2) DEFAULT 1
    `);

    await client.query(`
      UPDATE products SET kg_per_sachet = 1 WHERE kg_per_sachet IS NULL OR kg_per_sachet = 0
    `);
    await client.query(`
      UPDATE products SET sachets_per_carton = 1 WHERE sachets_per_carton IS NULL OR sachets_per_carton = 0
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        quantity_kg DECIMAL(12, 4) NOT NULL DEFAULT 0,
        quantity_sachets DECIMAL(12, 4) NOT NULL DEFAULT 0,
        quantity_cartons DECIMAL(12, 4) NOT NULL DEFAULT 0,
        unit_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='quantity_kg') THEN
          ALTER TABLE order_items ADD COLUMN quantity_kg DECIMAL(12, 4) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='quantity_sachets') THEN
          ALTER TABLE order_items ADD COLUMN quantity_sachets DECIMAL(12, 4) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='quantity_cartons') THEN
          ALTER TABLE order_items ADD COLUMN quantity_cartons DECIMAL(12, 4) NOT NULL DEFAULT 0;
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE order_items
      ALTER COLUMN quantity_kg TYPE DECIMAL(12, 4),
      ALTER COLUMN quantity_sachets TYPE DECIMAL(12, 4),
      ALTER COLUMN quantity_cartons TYPE DECIMAL(12, 4)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lead_comments_lead_id ON lead_comments(lead_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'salesperson',
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);

    await client.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_user_role' AND conrelid = 'users'::regclass) THEN
          ALTER TABLE users ADD CONSTRAINT valid_user_role CHECK (role IN ('admin', 'salesperson', 'driver'));
        END IF;
      END $$;
    `);

    // Widen existing role constraint if it only allows admin/salesperson
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_user_role' AND conrelid = 'users'::regclass) THEN
          ALTER TABLE users DROP CONSTRAINT valid_user_role;
          ALTER TABLE users ADD CONSTRAINT valid_user_role CHECK (role IN ('admin', 'salesperson', 'driver'));
        END IF;
      END $$;
    `);

    // Migrate orders from old salesperson_id to user_id if the columns still exist
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='salesperson_id')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='user_id') THEN
          ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
          UPDATE orders
          SET user_id = salespeople.user_id
          FROM salespeople
          WHERE orders.salesperson_id = salespeople.id
            AND salespeople.user_id IS NOT NULL;
          ALTER TABLE orders DROP COLUMN salesperson_id;
        ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='user_id') THEN
          ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
    `);

    // Drop legacy salespeople table if it exists
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='salespeople') THEN
          DROP TABLE IF EXISTS salespeople CASCADE;
        END IF;
      END $$;
    `);

    const existingUser = await client.query(
      "SELECT id, role FROM users WHERE email = $1",
      ["admin@example.com"]
    );
    if (existingUser.rows.length === 0) {
      const hash = await bcrypt.hash("admin123", 10);
      await client.query(
        "INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)",
        ["admin@example.com", hash, "Administrator", "admin"]
      );
    } else if (existingUser.rows[0].role !== "admin") {
      await client.query(
        "UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        ["admin", existingUser.rows[0].id]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface Lead {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  value: number;
  delivery_location: string | null;
  notes: string | null;
  assigned_to: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Order {
  id: number;
  lead_id: number | null;
  user_id: number | null;
  driver_id: number | null;
  customer_name: string;
  order_value: number;
  status: string;
  order_date: Date;
  delivery_status: string;
  delivery_address: string | null;
  shipped_date: Date | null;
  delivery_date: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PasswordReset {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface LeadComment {
  id: number;
  lead_id: number;
  user_id: number | null;
  user_name: string | null;
  comment: string;
  created_at: Date;
}

export interface Product {
  id: number;
  name: string;
  sku: string | null;
  description: string | null;
  cost_price: number;
  selling_price: number;
  stock_kg: number;
  kg_per_sachet: number;
  sachets_per_carton: number;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  product_name: string;
  quantity_kg: number;
  quantity_sachets: number;
  quantity_cartons: number;
  unit_price: number;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}
