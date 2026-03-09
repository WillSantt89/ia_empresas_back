const { Client } = require('ssh2');
const conn = new Client();

const SQL = `ALTER TABLE controle_historico DROP CONSTRAINT IF EXISTS controle_historico_acao_check;
ALTER TABLE controle_historico ADD CONSTRAINT controle_historico_acao_check
  CHECK (acao IN (
    'humano_assumiu', 'humano_devolveu', 'timeout_ia_reassumiu', 'admin_forcou',
    'operador_assumiu', 'desatribuido', 'transferencia_fila', 'auto_assignment',
    'transferencia_agente', 'finalizado'
  ));`;

const sqlB64 = Buffer.from(SQL).toString('base64');

conn.on('ready', () => {
  console.log('SSH connected');
  const cmd = [
    `echo ${sqlB64} | base64 -d > /tmp/m036.sql`,
    'CONTAINER=$(echo A1s2d3f4g5 | sudo -S docker ps -q -f name=wschat_ia_mult_empresas_db 2>/dev/null | head -1)',
    'echo A1s2d3f4g5 | sudo -S docker cp /tmp/m036.sql $CONTAINER:/tmp/m036.sql',
    'echo A1s2d3f4g5 | sudo -S docker exec $CONTAINER psql "postgres://postgres:eb0a428497ad695b787f@localhost:5432/wschat" -f /tmp/m036.sql',
    'rm /tmp/m036.sql',
  ].join(' && ');

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('exec error:', err); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stdout.write(d.toString()));
    stream.on('close', () => conn.end());
  });
});

conn.on('error', err => console.error('SSH error:', err.message));
conn.connect({ host: '15.235.36.103', port: 18000, username: 'santanacred', password: 'A1s2d3f4g5', readyTimeout: 20000 });
