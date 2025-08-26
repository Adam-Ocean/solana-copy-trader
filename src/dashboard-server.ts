import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3000');

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = readFileSync(join(__dirname, '../dashboard/index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (error) {
      res.writeHead(404);
      res.end('Dashboard not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`📱 Dashboard available at: http://localhost:${PORT}`);
  console.log(`   WebSocket endpoint: ws://localhost:${process.env.WS_SERVER_PORT || 4790}/ws`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});