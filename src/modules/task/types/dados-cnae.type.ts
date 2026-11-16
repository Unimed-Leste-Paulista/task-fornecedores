/** CNAEs de um estabelecimento extraídas do arquivo Estabelecimentos da Receita Federal (códigos de 7 dígitos). */
export type DadosCnae = {
  principal: string | null;
  secundarias: string[];
};
