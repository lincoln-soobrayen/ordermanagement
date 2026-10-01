declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): Record<string, unknown>;
}

declare module "cloudflare:workers" {
  export const env: {
    HYPERDRIVE: { connectionString: string };
  };
  export function waitUntil(promise: Promise<unknown>): void;
}
