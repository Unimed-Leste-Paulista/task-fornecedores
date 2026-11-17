import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { OrigemExecucao } from '../types/origem-execucao.type';
import type { StatusExecucao } from '../types/status-execucao.type';

/** Log de execuções da task. PK preenchida pelo trigger BI_TASK_FORNECEDORES_LOG. */
@Entity({ name: 'TASK_FORNECEDORES_LOG' })
export class TaskFornecedoresLogModel {
  @PrimaryGeneratedColumn({
    name: 'N_TASK_FORNECEDORES_LOG_PK',
    type: 'number',
  })
  taskFornecedoresLogPk!: number;

  @Column({ name: 'C_COMPETENCIA', type: 'varchar2', length: 7 })
  competencia!: string;

  @Column({ name: 'C_ORIGEM', type: 'varchar2', length: 20 })
  origem!: OrigemExecucao;

  // Coluna DATE no banco, mapeada como 'timestamp' de propósito: com type 'date' o TypeORM
  // grava TO_DATE('AAAA-MM-DD') e descarta a hora. O Oracle converte para DATE mantendo HH24:MI:SS.
  @Column({ name: 'D_INICIO_EXECUCAO', type: 'timestamp' })
  inicioExecucao!: Date;

  @Column({ name: 'D_FIM_EXECUCAO', type: 'timestamp', nullable: true })
  fimExecucao!: Date | null;

  @Column({ name: 'C_STATUS', type: 'varchar2', length: 20 })
  status!: StatusExecucao;

  @Column({
    name: 'N_FORNECEDORES_ATUALIZADOS',
    type: 'number',
    nullable: true,
  })
  fornecedoresAtualizados!: number | null;

  @Column({ name: 'A_MOTIVO_ERRO', type: 'clob', nullable: true })
  motivoErro!: string | null;

  /** CNPJs não encontrados nos arquivos da Receita, com a origem: "00.000.000/0000-00 (Simples); ..." */
  @Column({ name: 'A_CNPJS_NAO_ENCONTRADOS', type: 'clob', nullable: true })
  cnpjsNaoEncontrados!: string | null;
}
