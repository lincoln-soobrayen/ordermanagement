import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import { app } from "./app";
import { initDb } from "./db";

const PORT = process.env.PORT || 3000;

async function main(): Promise<void> {
  await initDb();
  const server = express();
  server.use(express.static(path.join(__dirname, "../public")));
  server.use(app);
  server.listen(PORT, () => {
    console.log(`Leads & Orders app running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
