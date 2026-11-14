// GET /healthz: a quick setup check that shows no keys.
import { allProjects } from "../lib/projects.js";

export const onRequest = async ({ env }) => {
  let projects = [];
  try {
    projects = await allProjects(env);
  } catch {}
  const lines = [
    "ok",
    `database DB: ${env.DB ? "connected" : "MISSING (Settings > Bindings > D1 database, name DB)"}`,
    `admin page: ${env.ADMIN_KEY ? "on" : "off (set ADMIN_KEY to use /admin.html)"}`,
    `projects: ${projects.length ? projects.map((p) => `#${p.appId}${p.name ? " " + p.name : ""}${p.readKey ? "" : " (no read key)"}`).join(", ") : "NONE (add one on /admin.html, or set PROJECTS)"}`,
  ];
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
};
