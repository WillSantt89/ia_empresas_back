import { Client } from 'ssh2';

const conn = new Client();

function execSSH(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => {});
      stream.on('close', () => resolve(stdout.trim()));
    });
  });
}

function sql(query) {
  return execSSH(`echo A1s2d3f4g5 | sudo -S docker exec 116ad0815256 psql -U postgres -d wschat -c "${query}"`);
}

conn.on('ready', async () => {
  console.log('=== Conversas ativas (detalhes) ===');
  console.log(await sql("SELECT id, contato_whatsapp, status, controlado_por, fila_id, operador_id FROM conversas WHERE status = 'ativo'"));

  console.log('\n=== Conversas com fila_id NULL ===');
  console.log(await sql("SELECT id, contato_whatsapp, status FROM conversas WHERE fila_id IS NULL"));

  console.log('\n=== Membros de filas ===');
  console.log(await sql("SELECT fm.fila_id, f.nome as fila, u.nome as membro, u.email FROM fila_membros fm JOIN filas_atendimento f ON f.id = fm.fila_id JOIN usuarios u ON u.id = fm.usuario_id"));

  conn.end();
}).connect({ host: '15.235.36.103', port: 18000, username: 'santanacred', password: 'A1s2d3f4g5' });
