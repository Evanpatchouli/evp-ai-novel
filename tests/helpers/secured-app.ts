import request from "supertest";
import { createApp } from "../../server/app.js";

export async function createSecuredTestApp(root: string) {
  const origin = "http://127.0.0.1";
  const app = createApp(root, {
    requestSecurity: { mode: "production", productionOrigin: origin },
  }).callback();
  const bootstrap = await request(app).get("/api/health");
  return {
    app,
    origin,
    sessionToken: bootstrap.body.data.sessionToken as string,
  };
}
