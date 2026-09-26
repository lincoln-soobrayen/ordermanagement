import bcrypt from "bcrypt";
import { pool, User } from "./db";

export async function authenticateUser(
  email: string,
  password: string
): Promise<User | null> {
  const result = await pool.query(
    "SELECT id, email, password_hash, name, created_at FROM users WHERE email = $1",
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
    created_at: user.created_at,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
