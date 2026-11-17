/** Fornecedor com CNPJ válido (14 dígitos, sem formatação) usado nos cruzamentos com a Receita. */
export type CnpjFornecedor = {
  fornecedorPk: number;
  cnpj: string;
};

/** Resultado do cruzamento com um tipo de arquivo da Receita (Simples ou Estabelecimentos). */
export type ResultadoCruzamento = {
  /** PKs dos fornecedores atualizados. */
  atualizados: Set<number>;
  /** CNPJs completos (14 dígitos, ordenados) não encontrados nos arquivos. */
  naoEncontrados: string[];
};

/** Resultado de uma execução da task, gravado no log. */
export type ResultadoTask = {
  fornecedoresAtualizados: number;
  /** Ex.: "12.345.678/0001-90 (Simples); 98.765.432/0001-10 (Estabelecimentos)". Null se todos foram encontrados. */
  cnpjsNaoEncontrados: string | null;
};
