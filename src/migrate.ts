import dotenv from "dotenv";
dotenv.config();

import { closeSharedPool, initDb, pruneExpiredSessions, syncInactiveClientFollowUps } from "./db";

async function main(): Promise<void> {
  await initDb();
  await pruneExpiredSessions();
  await syncInactiveClientFollowUps();
  console.log("Database schema is up to date");
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedPool());
