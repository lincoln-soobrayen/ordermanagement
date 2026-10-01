import { httpServerHandler } from "cloudflare:node";
import { env, waitUntil } from "cloudflare:workers";
import { Pool } from "pg";
import { app } from "./app";
import { usePerRequestPools } from "./db";

const PORT = 3000;

usePerRequestPools({
  connectionString: () => env.HYPERDRIVE.connectionString,
  waitUntil,
});

app.listen(PORT);

const httpHandler = httpServerHandler({ port: PORT });

export default {
  ...httpHandler,
  async scheduled(): Promise<void> {
    const cronPool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
    try {
      await cronPool.query('DELETE FROM "session" WHERE expire < NOW()');
    } finally {
      await cronPool.end();
    }
  },
};
