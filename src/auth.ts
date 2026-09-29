import bcrypt from "bcrypt";
import crypto from "crypto";
import { Request } from "express";
import nodemailer from "nodemailer";
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

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || "587"),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };
}

function hasSmtpConfig(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function buildPasswordResetUrl(token: string): string {
  const base = process.env.PASSWORD_RESET_URL_BASE || `http://localhost:${process.env.PORT || 3000}`;
  return `${base.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(
  user: Pick<User, "email" | "name">,
  resetUrl: string
): Promise<void> {
  const appName = process.env.APP_NAME || "Leads & Orders";
  const from = process.env.SMTP_FROM || `"${appName}" <noreply@example.com>`;
  const subject = `Reset your ${appName} password`;
  const html = `
    <p>Hi ${user.name || user.email},</p>
    <p>Click the link below to reset your password. This link expires in 1 hour.</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  if (hasSmtpConfig()) {
    const transporter = nodemailer.createTransport(getSmtpConfig());
    await transporter.sendMail({
      from,
      to: user.email,
      subject,
      html,
    });
    console.log(`Password reset email sent to ${user.email}`);
  } else {
    console.log(`[No SMTP configured] Password reset link for ${user.email}: ${resetUrl}`);
  }
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
