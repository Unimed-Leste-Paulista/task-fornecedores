import type { Periodo } from '../types/periodo.type';

/** Retorna o mês anterior à data informada no formato AAAA-MM. */
export function competenciaMesAnterior(data: Date = new Date()): string {
  const ref = new Date(data.getFullYear(), data.getMonth() - 1, 1);
  const mes = String(ref.getMonth() + 1).padStart(2, '0');
  return `${ref.getFullYear()}-${mes}`;
}

/**
 * Últimos 12 meses fechados em relação à data informada:
 * do 1º dia do mês 12 meses atrás até o 1º dia do mês atual (exclusivo).
 * Ex.: em 13/11/2026 -> 2025-11-01 a 2026-11-01 (nov/2025 a out/2026).
 */
export function periodoUltimos12Meses(data: Date = new Date()): Periodo {
  return {
    inicio: formatarData(new Date(data.getFullYear(), data.getMonth() - 12, 1)),
    fimExclusivo: formatarData(
      new Date(data.getFullYear(), data.getMonth(), 1),
    ),
  };
}

function formatarData(data: Date): string {
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}
