const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const SSH_CONFIG = {
  host: '15.235.36.103',
  port: 18000,
  username: 'santanacred',
  password: 'A1s2d3f4g5',
  readyTimeout: 30000,
};

const LOCAL_BASE = __dirname;
const REMOTE_BASE = '/etc/easypanel/projects/wschat/ia_empresas_back/code/backend';
const SUDO_PASS = 'A1s2d3f4g5';

// Collect all files to upload
function collectFiles(dir, baseDir = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'scripts'].includes(entry.name)) continue;
      files.push(...collectFiles(fullPath, baseDir));
    } else {
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      files.push({ local: fullPath, remote: rel });
    }
  }
  return files;
}

async function deploy() {
  // Only upload src/, migrations/, package.json, Dockerfile
  const filesToUpload = [];

  // src/ directory
  filesToUpload.push(...collectFiles(path.join(LOCAL_BASE, 'src'), LOCAL_BASE));

  // migrations/ directory
  filesToUpload.push(...collectFiles(path.join(LOCAL_BASE, 'migrations'), LOCAL_BASE));

  // package.json
  filesToUpload.push({ local: path.join(LOCAL_BASE, 'package.json'), remote: 'package.json' });

  // Dockerfile if exists
  const dockerfilePath = path.join(LOCAL_BASE, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    filesToUpload.push({ local: dockerfilePath, remote: 'Dockerfile' });
  }

  // .dockerignore if exists
  const dockerignorePath = path.join(LOCAL_BASE, '.dockerignore');
  if (fs.existsSync(dockerignorePath)) {
    filesToUpload.push({ local: dockerignorePath, remote: '.dockerignore' });
  }

  console.log(`Files to upload: ${filesToUpload.length}`);

  const conn = new Client();

  conn.on('ready', () => {
    console.log('SSH connected, starting SFTP...');

    conn.sftp((err, sftp) => {
      if (err) { console.error('SFTP error:', err); conn.end(); return; }

      // Upload all files to /tmp/backend-deploy/
      const tmpBase = '/tmp/backend-deploy';
      let uploaded = 0;

      // Create directories first, then upload files
      const dirs = new Set();
      for (const f of filesToUpload) {
        const dir = path.dirname(f.remote);
        if (dir !== '.') {
          const parts = dir.split('/');
          for (let i = 1; i <= parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'));
          }
        }
      }

      // Use exec to create all dirs at once
      const mkdirCmd = [
        `rm -rf ${tmpBase}`,
        `mkdir -p ${tmpBase}`,
        ...Array.from(dirs).sort().map(d => `mkdir -p ${tmpBase}/${d}`),
      ].join(' && ');

      conn.exec(mkdirCmd, (err, stream) => {
        if (err) { console.error('mkdir error:', err); conn.end(); return; }
        stream.on('close', () => {
          console.log('Directories created, uploading files...');
          uploadNext();
        });
        stream.resume();
        stream.stderr.resume();
      });

      function uploadNext() {
        if (uploaded >= filesToUpload.length) {
          console.log(`All ${uploaded} files uploaded. Copying to destination...`);
          doCopy();
          return;
        }

        const f = filesToUpload[uploaded];
        const remotePath = `${tmpBase}/${f.remote}`;
        const data = fs.readFileSync(f.local);

        sftp.writeFile(remotePath, data, (err) => {
          if (err) {
            console.error(`Upload error ${f.remote}:`, err.message);
          }
          uploaded++;
          if (uploaded % 10 === 0) console.log(`  Uploaded ${uploaded}/${filesToUpload.length}...`);
          uploadNext();
        });
      }

      function doCopy() {
        const cmd = [
          `echo ${SUDO_PASS} | sudo -S cp -r ${tmpBase}/* ${REMOTE_BASE}/ 2>&1`,
          `rm -rf ${tmpBase}`,
          `echo "--- Files copied. Building Docker image ---"`,
          `cd ${REMOTE_BASE}/.. && echo ${SUDO_PASS} | sudo -S docker build --no-cache -t easypanel/wschat/ia_empresas_back:latest . 2>&1`,
          `echo "--- Updating service ---"`,
          `echo ${SUDO_PASS} | sudo -S docker service update --force --image easypanel/wschat/ia_empresas_back:latest wschat_ia_empresas_back 2>&1`,
        ].join(' && ');

        conn.exec(cmd, (err, stream) => {
          if (err) { console.error('exec error:', err); conn.end(); return; }
          stream.on('data', d => process.stdout.write(d.toString()));
          stream.stderr.on('data', d => process.stdout.write(d.toString()));
          stream.on('close', () => {
            console.log('\nDeploy complete!');
            conn.end();
          });
        });
      }
    });
  });

  conn.on('error', err => console.error('SSH error:', err.message));
  conn.connect(SSH_CONFIG);
}

deploy().catch(console.error);
