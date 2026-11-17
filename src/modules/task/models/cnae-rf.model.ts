import { Column, Entity, PrimaryColumn } from 'typeorm';

/** CNAEs da Receita Federal (arquivo Cnaes.zip), usadas para descrever as CNAEs dos fornecedores. */
@Entity({ name: 'DW_FORNECEDORES_CNAE_RF', schema: 'DW' })
export class CnaeRfModel {
  @PrimaryColumn({
    name: 'C_FORNECEDORES_CNAE_PK',
    type: 'varchar2',
    length: 255,
  })
  codigo!: string;

  @Column({ name: 'DESCRICAO', type: 'varchar2', length: 255 })
  descricao!: string;
}
