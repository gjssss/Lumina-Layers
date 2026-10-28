"use strict";

// Static file server used by the packaged desktop app.
//
// In development the Electron shell spawns the Vite dev server, which both
// serves the frontend and proxies ``/api`` to the Python backend. A packaged
// build has no Vite, so the main process serves the pre-built
// ``frontend/dist`` itself and reproduces the two behaviours the app relies
// on:
//   1. static assets with an SPA history fallback to ``index.html``;
//   2. ``/api`` requests proxied to the backend origin unchanged.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function resolveRequestPath(rootDir, requestUrl) {
  const { pathname } = new URL(requestUrl, "http://127.0.0.1");
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.join(rootDir, relative);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + path.sep)
  ) {
    return null;
  }
  return resolvedCandidate;
}

function proxyApiRequest(req, res, apiTarget) {
  const target = new URL(req.url, apiTarget);
  const proxyReq = http.request(
    target,
    {
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ detail: "Backend unavailable" }));
  });
  req.pipe(proxyReq);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(res);
}

function createStaticServer({ rootDir, apiTarget }) {
  const indexPath = path.join(rootDir, "index.html");
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      proxyApiRequest(req, res, apiTarget);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }
    const filePath = resolveRequestPath(rootDir, req.url);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveFile(res, filePath);
      return;
    }
    // SPA history fallback: unknown paths without a file extension are
    // client-side routes; paths that look like files return a real 404 so
    // missing assets surface instead of silently returning HTML.
    if (!path.extname(pathname) && fs.existsSync(indexPath)) {
      serveFile(res, indexPath);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });
  return server;
}

module.exports = { createStaticServer, resolveRequestPath };
