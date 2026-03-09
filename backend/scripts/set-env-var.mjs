import { Client } from 'ssh2';

const conn = new Client();

function execSSH(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
    });
  });
}

conn.on('ready', async () => {
  console.log('Conectado ao servidor');

  const VERIFY_TOKEN = 'wschat_meta_verify_2026';

  // Adicionar env var via docker service update --env-add
  console.log('Adicionando WHATSAPP_VERIFY_TOKEN via docker service update...');
  const result = await execSSH(`echo A1s2d3f4g5 | sudo -S docker service update --env-add "WHATSAPP_VERIFY_TOKEN=${VERIFY_TOKEN}" wschat_ia_empresas_back 2>&1`);
  console.log(result.stdout);

  // Aguardar convergência
  console.log('\nAguardando 10s para o container subir...');
  await new Promise(r => setTimeout(r, 10000));

  // Verificar no novo container
  const newContainer = await execSSH(`echo A1s2d3f4g5 | sudo -S docker ps --format '{{.Names}}' 2>/dev/null | grep ia_empresas_back`);
  console.log('Novo container:', newContainer.stdout);

  if (newContainer.stdout) {
    const envCheck = await execSSH(`echo A1s2d3f4g5 | sudo -S docker exec ${newContainer.stdout} env 2>/dev/null | grep WHATSAPP`);
    console.log('WHATSAPP_VERIFY_TOKEN:', envCheck.stdout);
  }

  console.log('\n✓ Token configurado:', VERIFY_TOKEN);

  conn.end();
}).connect({ host: '15.235.36.103', port: 18000, username: 'santanacred', password: 'A1s2d3f4g5' });
