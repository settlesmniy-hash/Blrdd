import app from "./api";

const port = Number(process.env.PORT ?? 3000);
const distDir = `${import.meta.dir}/../dist`;
const indexPath = `${distDir}/index.html`;

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }

    const filePath = getStaticFilePath(url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file(indexPath);
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

// ─── Trade Engine Loop ────────────────────────────────────────────────────
// Runs every 5 minutes, calls the scan endpoint internally
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runEngineScan() {
  try {
    const url = `http://localhost:${server.port}/api/trade-engine/scan`;
    const res = await fetch(url, { method: "POST" });
    const data = await res.json() as any;

    if (data.ok) {
      console.log(`[Engine] Scan complete — ${data.markets_scanned} markets, ${data.trades_executed} trades (${data.paper_mode ? "paper" : "LIVE"})`);
    } else {
      console.log(`[Engine] Scan skipped — ${data.reason || data.error || "unknown"}`);
    }
  } catch (e) {
    console.error("[Engine] Scan error:", e);
  }
}

// Initial scan 10 seconds after startup (let server fully boot)
setTimeout(runEngineScan, 10_000);

// Then every 5 minutes
setInterval(runEngineScan, SCAN_INTERVAL_MS);

console.log(`[Engine] Trade engine loop started — scanning every ${SCAN_INTERVAL_MS / 60000} minutes`);

function getStaticFilePath(pathname: string) {
  const cleanPath = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replaceAll("..", "");

  return cleanPath ? `${distDir}/${cleanPath}` : indexPath;
}
