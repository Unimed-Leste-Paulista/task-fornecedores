import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'DW_FORNECEDORES', schema: 'DW' })
export class FornecedorModel {
  @PrimaryColumn({ name: 'N_FORNECEDOR_PK', type: 'number' })
  fornecedorPk!: number;

  @Column({ name: 'C_CODIGO_FORNECEDOR', type: 'varchar2', length: 255 })
  codigoFornecedor!: string;

  @Column({ name: 'C_RAZAO_SOCIAL', type: 'varchar2', length: 4000 })
  razaoSocial!: string;

  @Column({
    name: 'C_NOME_FANTASIA',
    type: 'varchar2',
    length: 4000,
    nullable: true,
  })
  nomeFantasia!: string | null;

  @Column({ name: 'C_NATUREZA_JURIDICA', type: 'varchar2', length: 50 })
  naturezaJuridica!: string;

  @Column({ name: 'C_CNPJ_CPF', type: 'varchar2', length: 18 })
  cnpjCpf!: string;

  @Column({ name: 'C_SITUACAO', type: 'varchar2', length: 255 })
  situacao!: string;

  @Column({
    name: 'C_ENDERECO_COMPLETO',
    type: 'varchar2',
    length: 4000,
    nullable: true,
  })
  enderecoCompleto!: string | null;

  @Column({
    name: 'C_INSCRICAO_ESTADUAL',
    type: 'varchar2',
    length: 255,
    nullable: true,
  })
  inscricaoEstadual!: string | null;

  @Column({
    name: 'C_INSCRICAO_MUNICIPAL',
    type: 'varchar2',
    length: 255,
    nullable: true,
  })
  inscricaoMunicipal!: string | null;

  @Column({
    name: 'C_CNAE_PRINCIPAL_SOLUS',
    type: 'varchar2',
    length: 255,
    nullable: true,
  })
  cnaePrincipalSolus!: string | null;

  @Column({ name: 'A_CNAE_SECUNDARIAS_SOLUS', type: 'clob', nullable: true })
  cnaeSecundariasSolus!: string | null;

  @Column({
    name: 'C_CONTATO_CAD_FORNECEDOR',
    type: 'varchar2',
    length: 4000,
    nullable: true,
  })
  contatoCadFornecedor!: string | null;

  @Column({
    name: 'C_CONTATO_CAD_PESSOA',
    type: 'varchar2',
    length: 4000,
    nullable: true,
  })
  contatoCadPessoa!: string | null;

  @Column({
    name: 'C_TIPO_FORNECEDOR',
    type: 'varchar2',
    length: 255,
    nullable: true,
  })
  tipoFornecedor!: string | null;

  @Column({
    name: 'C_TIPO_SERVICO',
    type: 'varchar2',
    length: 255,
    nullable: true,
  })
  tipoServico!: string | null;

  @Column({ name: 'A_ALTERACAO_REGISTRO', type: 'clob', nullable: true })
  alteracaoRegistro!: string | null;

  @Column({
    name: 'A_TODAS_ALTERACOES_REG_TRIBUTARIO',
    type: 'clob',
    nullable: true,
  })
  todasAlteracoesRegTributario!: string | null;

  @Column({
    name: 'C_SIMPLES_RECEITA_FEDERAL',
    type: 'varchar2',
    length: 1,
    nullable: true,
  })
  simplesReceitaFederal!: string | null;

  @Column({
    name: 'C_MEI_RECEITA_FEDERAL',
    type: 'varchar2',
    length: 1,
    nullable: true,
  })
  meiReceitaFederal!: string | null;

  @Column({ name: 'D_SIMPLES_INCLUSAO', type: 'date', nullable: true })
  simplesInclusao!: Date | null;

  @Column({ name: 'D_SIMPLES_SAIDA', type: 'date', nullable: true })
  simplesSaida!: Date | null;

  @Column({ name: 'D_MEI_INCLUSAO', type: 'date', nullable: true })
  meiInclusao!: Date | null;

  @Column({ name: 'D_MEI_SAIDA', type: 'date', nullable: true })
  meiSaida!: Date | null;

  @Column({
    name: 'C_CNAE_PRINCIPAL_RECEITA_FEDERAL',
    type: 'varchar2',
    length: 255,
    nullable: true,
  })
  cnaePrincipalReceitaFederal!: string | null;

  @Column({
    name: 'A_CNAE_SECUNDARIAS_RECEITA_FEDERAL',
    type: 'clob',
    nullable: true,
  })
  cnaeSecundariasReceitaFederal!: string | null;

  @Column({ name: 'C_CATEGORIA_FORNECEDOR', type: 'varchar2', length: 255 })
  categoriaFornecedor!: string;

  @Column({ name: 'C_VINCULO', type: 'varchar2', length: 255, nullable: true })
  vinculo!: string | null;
}
