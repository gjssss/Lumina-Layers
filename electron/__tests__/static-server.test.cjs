"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStaticServer } = require("../static-server.cjs");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      })
      .on("error", reject);
  });
}

test("static server serves dist files, SPA fallback and api proxy", async (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html>lumina</html>");
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('ok');");

  const backend = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echoed: req.url }));
  });
  const backendPort = await listen(backend);

  const server = createStaticServer({
    rootDir: dist,
    apiTarget: `http://127.0.0.1:${backendPort}`,
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
    backend.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  const index = await get(port, "/");
  assert.equal(index.status, 200);
  assert.match(index.body, /lumina/);

  const asset = await get(port, "/assets/app.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /javascript/);
  assert.match(asset.body, /console\.log/);

  const route = await get(port, "/some/client/route");
  assert.equal(route.status, 200);
  assert.match(route.body, /lumina/);

  const missing = await get(port, "/assets/missing.js");
  assert.equal(missing.status, 404);

  const traversal = await get(port, "/../secret.txt");
  assert.equal(traversal.status, 404);

  const api = await get(port, "/api/health");
  assert.equal(api.status, 200);
  assert.deepEqual(JSON.parse(api.body), { echoed: "/api/health" });
});
