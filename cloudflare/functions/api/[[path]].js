// /api/*: dashboard API (same routes and JSON as the Go query service).
import { handleApi } from "../../lib/api.js";

export const onRequest = (ctx) => handleApi(ctx.request, ctx.env);
