import { FornecedorModel } from '../models/fornecedor.model';

/** Dados do Simples Nacional/MEI extraídos do arquivo da Receita Federal. */
export type DadosSimples = Pick<
  FornecedorModel,
  | 'simplesReceitaFederal'
  | 'simplesInclusao'
  | 'simplesSaida'
  | 'meiReceitaFederal'
  | 'meiInclusao'
  | 'meiSaida'
>;
