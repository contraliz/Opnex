const express = require('express');
const http = require('node:http');
const onFinished = require('on-finished');
const zlib = require('node:zlib');

const mode = process.argv[2];
const app = express();
let activeRequest;
let deferredTrailingBytes;
app.disable('x-powered-by');
app.use(express.json({ limit: '17mb' }));
app.get('/health', (_req, res) => res.status(200).send('healthy'));
app.post('/echo', (req, res) => res.status(200).json(req.body));
app.post('/sequenced', (req, res, next) => {
  onFinished(req, error => {
    if (error) return next(error);
    res.status(200).json(req.body);
  });
  activeRequest.end(deferredTrailingBytes);
});
const server = http.createServer(app);

function reportAfterHealth(response, body) {
  let responseBody = '';
  response.setEncoding('utf8').on('data', chunk => { responseBody += chunk; });
  response.on('end', () => {
    setTimeout(() => {
      const port = server.address().port;
      const probe = http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, health => {
        health.resume();
        health.on('end', () => {
          process.stdout.write(JSON.stringify({
            status: response.statusCode,
            body: body === undefined ? responseBody : body,
            health: health.statusCode
          }) + '\n');
          server.close();
        });
      });
      probe.on('error', error => {
        process.stdout.write(JSON.stringify({ status: response.statusCode, body: responseBody, healthError: error.message }) + '\n');
        server.close();
      });
    }, 200);
  });
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  let path = '/not-a-route';
  let contentEncoding = 'gzip';
  let body;
  let firstChunk;

  if (mode === 'gzip-trailing') {
    body = Buffer.concat([
      Buffer.from('1f8b0800000000000003ab564a54b232ac0500afac1b5607000000', 'hex'),
      Buffer.from([0x00]),
      Buffer.alloc(100 * 1024, 0x58)
    ]);
  } else if (mode === 'deflate-trailing') {
    contentEncoding = 'deflate';
    body = Buffer.concat([
      Buffer.from('789cab564a54b232ac0500082a0209', 'hex'),
      Buffer.from([0x00]),
      Buffer.alloc(1024)
    ]);
  } else if (mode === 'sequenced-gzip-trailing') {
    contentEncoding = 'gzip';
    path = '/sequenced';
    firstChunk = Buffer.concat([
      Buffer.from('1f8b0800000000000003ab564a54b232ac0500afac1b5607000000', 'hex'),
      Buffer.from([0x00])
    ]);
    deferredTrailingBytes = Buffer.alloc(100 * 1024, 0x58);
    body = Buffer.concat([firstChunk, deferredTrailingBytes]);
  } else if (mode === 'compressed-control') {
    path = '/echo';
    body = zlib.gzipSync(Buffer.from('{"a":1}'));
  } else {
    throw new Error('Unknown probe mode: ' + mode);
  }

  activeRequest = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path,
    agent: false,
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': contentEncoding,
      'Content-Length': body.length
    }
  }, response => reportAfterHealth(response));
  activeRequest.on('error', error => {
    console.error(error.stack || error);
    server.close();
    process.exitCode = 1;
  });
  if (firstChunk) activeRequest.write(firstChunk);
  else activeRequest.end(body);
});
