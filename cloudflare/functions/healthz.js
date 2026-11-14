// GET /healthz: a quick setup check that shows no keys.
import { projectsFrom } from "../lib/config.js";

export const onRequest = ({ env }) => {
  const projects = projectsFrom(env);
  const lines = [
    "ok",
    `database DB: ${env.DB ? "connected" : "MISSING (Settings > Bindings > D1 database, name DB)"}`,
    `projects: ${projects.length ? projects.map((p) => `#${p.appId}${p.name ? " " + p.name : ""}${p.readKey ? "" : " (no read key)"}`).join(", ") : "NONE (Settings > Variables and Secrets > PROJECTS, then redeploy)"}`,
  ];
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
};
