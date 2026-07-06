// Chop MVP -- Node.js standalone server
// Run: node server.js
// Tunnel: npx cloudflared tunnel --url http://localhost:8787

const http = require('http');
const { worker } = require('./src/worker.js');

// Worker's fetch expects Request/Response Web API
// Node 18+ has these built-in

const server = http.createServer(async (req, res) => {
  // Build a Web API Request from Node's IncomingMessage
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:8787'}`);
  const headers = new Headers();
  for (let i = 0; i < req.headersDistinct?.length; i++) {
    // Node 18+ headersDistinct for multi-value headers
  }
  // Simple approach: copy headers one by one
  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else if (val) {
      headers.set(key, val);
    }
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: body.length > 0 ? body : undefined
  });

  try {
    const response = await worker.fetch(request, {}, {});
    
    // Write response back to Node.js response
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    
    if (response.body) {
      const reader = response.body.getReader();
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            res.end();
            return;
          }
          res.write(Buffer.from(value));
          pump();
        }).catch(err => {
          console.error('pump error:', err);
          if (!res.writableEnded) res.end();
        });
      };
      pump();
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Worker error:', err);
    res.writeHead(500);
    res.end('Internal Server Error: ' + err.message);
  }
});

const PORT = parseInt(process.env.PORT || '8787');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chop MVP server running on http://0.0.0.0:${PORT}`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://${require('os').hostname()}:${PORT}`);
  console.log(`\nTo share with others, run in another terminal:`);
  console.log(`  npx cloudflared tunnel --url http://localhost:${PORT}`);
});