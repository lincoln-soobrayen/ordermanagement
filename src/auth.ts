import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Request } from "express";
import { pool, User } from "./db";

export async function authenticateUser(
  email: string,
  password: string
): Promise<User | null> {
  const result = await pool.query(
    "SELECT id, email, password_hash, name, role, is_active, created_at, updated_at FROM users WHERE email = $1 AND is_active = true",
    [email]
  );
  const user = result.rows[0];
  if (!user) return null;

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    is_active: user.is_active,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function isAdmin(req: Request): boolean {
  return req.session.user?.role === "admin";
}

export function isDriver(req: Request): boolean {
  return req.session.user?.role === "driver";
}

export function generatePasswordResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function buildPasswordResetUrl(token: string): string {
  const base = process.env.PASSWORD_RESET_URL_BASE || `http://localhost:${process.env.PORT || 3000}`;
  return `${base.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(
  user: Pick<User, "email" | "name">,
  resetUrl: string
): Promise<void> {
  console.log(`[Email not configured] Password reset link for ${user.email}: ${resetUrl}`);
}

export async function createPasswordResetToken(userId: number): Promise<string> {
  const token = generatePasswordResetToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash, expiresAt]
  );
  return token;
}

export async function consumePasswordResetToken(token: string): Promise<number | null> {
  const tokenHash = hashToken(token);
  const result = await pool.query(
    "SELECT user_id FROM password_resets WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
    [tokenHash]
  );
  if (result.rows.length === 0) return null;
  const userId = result.rows[0].user_id as number;
  await pool.query("DELETE FROM password_resets WHERE token_hash = $1", [tokenHash]);
  return userId;
}
