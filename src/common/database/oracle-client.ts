import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as oracledb from 'oracledb';

/**
 * Inicializa o node-oracledb em modo thick usando o Oracle Client em LIB_DIR.
 * O modo thick é obrigatório: as bases exigem Native Network Encryption (ORA-12660 no modo thin).
 * Precisa rodar antes de qualquer conexão ser criada e só pode rodar uma vez por processo.
 */
export function inicializarOracleClient(): void {
  if (!oracledb.thin) return; // já inicializado em modo thick

  const libDir = process.env.LIB_DIR?.trim();
  if (!libDir) {
    throw new Error(
      'LIB_DIR não definida. Informe no .env o diretório do Oracle Client 64-bit (pasta que contém o oci.dll).',
    );
  }
  if (process.platform === 'win32' && !existsSync(join(libDir, 'oci.dll'))) {
    throw new Error(`oci.dll não encontrada em LIB_DIR (${libDir}).`);
  }

  oracledb.initOracleClient({ libDir });
}
