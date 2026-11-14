// POST /e: event ingestion (same contract as the Go collector).
import { handleIngest } from "../lib/api.js";

export const onRequest = (ctx) => handleIngest(ctx.request, ctx.env, (p) => ctx.waitUntil(p));
