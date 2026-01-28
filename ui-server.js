#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SCREENSHOTS_DIR,
  processInParallel,
  processUrl,
  closeBrowser,
} = require('./screenshot');

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.normalize(path.join(publicDir, urlPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = ext === '.css'
      ? 'text/css'
      : ext === '.js'
        ? 'application/javascript'
        : 'text/html';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/capture') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Invalid JSON payload.' });
        return;
      }

      const urls = Array.isArray(payload.urls)
        ? payload.urls.map(url => url.trim()).filter(Boolean)
        : [];

      if (urls.length === 0) {
        sendJson(res, 400, { error: 'Please provide at least one URL.' });
        return;
      }

      const outputDir = payload.outputDir
        ? path.resolve(payload.outputDir)
        : DEFAULT_SCREENSHOTS_DIR;
      const parallel = Number(payload.parallel) || 3;
      const options = {
        thread: Boolean(payload.thread),
        bento: Boolean(payload.bento),
      };

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const startTime = Date.now();
      try {
        const results = urls.length === 1
          ? [await processUrl(urls[0], 0, 1, outputDir, options)]
          : await processInParallel(urls, outputDir, parallel, options);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const successful = results.filter(result => result.success);
        const failed = results.filter(result => !result.success);

        sendJson(res, 200, {
          outputDir,
          elapsedSeconds: Number(elapsed),
          totals: {
            urls: urls.length,
            successful: successful.length,
            failed: failed.length,
          },
          results,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`UI running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});
