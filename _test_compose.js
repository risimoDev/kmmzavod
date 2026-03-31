const http = require('http');
const fs = require('fs');

const body = JSON.stringify({
  job_id: 'diag_5',
  tenant_id: 'test',
  output_key: 'test/diag.mp4',
  scenes: [{
    scene_id: 's0',
    type: 'image',
    storage_key: 'test/compose/dummy/scene_0_red.png',
    duration_sec: 3,
    transition: 'fade',
    transition_duration: 0.3,
    ken_burns: 'auto',
  }],
  subtitles: [],
  settings: { subtitle_style: 'tiktok' },
});

const opts = {
  hostname: 'localhost',
  port: 8000,
  path: '/compose',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = http.request(opts, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(data);
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.log(`ERROR: ${e.message}`);
  process.exit(1);
});

req.write(body);
req.end();
