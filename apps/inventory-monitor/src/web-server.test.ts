import { describe, expect, it, vi } from "vitest";
import { startInventoryWebServer } from "./web-server.js";

describe("inventory review server", () => {
  it("uses a one-time launch token, idle cookie and CSRF boundary", async () => {
    const repository = {
      overview: vi.fn(async () => ({ counts: { products: 0,skus: 0,incidents: 0 } })),
      reviewIncident: vi.fn(async () => undefined)
    };
    const server = await startInventoryWebServer({ repository,shopId:"10461048",port:0 });
    try {
      const launch = new URL(server.launchUrl);
      const launchToken = new URLSearchParams(launch.hash.slice(1)).get("token");
      expect(launch.hostname).toBe("127.0.0.1");
      expect(launchToken).toBeTruthy();
      const session = await fetch(`http://127.0.0.1:${server.port}/api/session`,{
        method:"POST",headers:{ "content-type":"application/json" },
        body:JSON.stringify({ token:launchToken })
      });
      expect(session.status).toBe(200);
      const cookie = session.headers.get("set-cookie")?.split(";",1)[0];
      expect(session.headers.get("set-cookie")).toContain("HttpOnly");
      expect(session.headers.get("set-cookie")).toContain("SameSite=Strict");
      const { csrf } = await session.json() as { csrf: string };
      const reused = await fetch(`http://127.0.0.1:${server.port}/api/session`,{
        method:"POST",headers:{ "content-type":"application/json" },
        body:JSON.stringify({ token:launchToken })
      });
      expect(reused.status).toBe(403);
      const overview = await fetch(`http://127.0.0.1:${server.port}/api/overview`,{
        headers:{ cookie:cookie! }
      });
      expect(overview.status).toBe(200);
      expect(overview.headers.get("cache-control")).toBe("no-store");
      const rejected = await fetch(`http://127.0.0.1:${server.port}/api/reviews`,{
        method:"POST",headers:{ cookie:cookie!,"content-type":"application/json" },
        body:JSON.stringify({ incidentId:"incident-1",decision:"valid",note:"" })
      });
      expect(rejected.status).toBe(403);
      const accepted = await fetch(`http://127.0.0.1:${server.port}/api/reviews`,{
        method:"POST",headers:{ cookie:cookie!,"content-type":"application/json","x-csrf-token":csrf },
        body:JSON.stringify({ incidentId:"incident-1",decision:"valid",note:"影子确认" })
      });
      expect(accepted.status).toBe(200);
      expect(repository.reviewIncident).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
