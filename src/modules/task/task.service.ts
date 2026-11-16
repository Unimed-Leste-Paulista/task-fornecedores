import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { EntityManager, In, Repository } from 'typeorm';
import * as yauzl from 'yauzl';
import { CnaeRfModel } from './models/cnae-rf.model';
import { FornecedorModel } from './models/fornecedor.model';
import { DadosCnae } from './types/dados-cnae.type';
import { DadosSimples } from './types/dados-simples.type';
import type {
  CnpjFornecedor,
  ResultadoCruzamento,
  ResultadoTask,
} from './types/resultado-task.type';
import { periodoUltimos12Meses } from './utils/competencia.util';

const URL_BASE_RECEITA =
  'https://arquivos.receitafederal.gov.br/public.php/dav/files/YggdBLfdninEJX9';

/** Arquivos de estabelecimentos da pasta da competência: Estabelecimentos0.zip, Estabelecimentos1.zip... */
const PADRAO_ARQUIVO_ESTABELECIMENTOS = /^Estabelecimentos(\d+)\.zip$/;

/** Conteúdo dos elementos <href> da resposta PROPFIND (WebDAV), com qualquer prefixo de namespace. */
const HREF_WEBDAV = /<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/gi;

/** Downloads da Receita: tentativas por arquivo e espera base entre elas (cresce a cada tentativa). */
const TENTATIVAS_DOWNLOAD = 3;
const ESPERA_ENTRE_TENTATIVAS_MS = 30_000;

/** Assinatura do início de um arquivo zip (local file header "PK\x03\x04"). */
const ASSINATURA_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Assinatura do registro "End of central directory" ("PK\x05\x06"), que fecha todo zip. */
const ASSINATURA_FIM_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** O registro de fim tem 22 bytes e pode ser seguido de comentário de até 65.535 bytes. */
const TAMANHO_MAX_FIM_ZIP = 22 + 65_535;

/** Quantidade de CNAEs por MERGE na carga da DW_FORNECEDORES_CNAE_RF. */
const TAMANHO_LOTE_CNAES = 500;

/**
 * Layout do arquivo Simples da Receita Federal (CSV separado por ";", campos entre aspas):
 * 0 CNPJ_BASICO | 1 OPCAO_SIMPLES | 2 DATA_OPCAO_SIMPLES | 3 DATA_EXCLUSAO_SIMPLES
 * 4 OPCAO_MEI   | 5 DATA_OPCAO_MEI | 6 DATA_EXCLUSAO_MEI
 * Índices abaixo são base 0 (equivalem às colunas 2 a 7 contando a partir de 1).
 */
const COL = {
  CNPJ_BASICO: 0,
  OPCAO_SIMPLES: 1,
  DATA_OPCAO_SIMPLES: 2,
  DATA_EXCLUSAO_SIMPLES: 3,
  OPCAO_MEI: 4,
  DATA_OPCAO_MEI: 5,
  DATA_EXCLUSAO_MEI: 6,
} as const;

/**
 * Layout do arquivo Estabelecimentos (30 campos entre aspas, separados por ";").
 * Índices base 0: CNPJ básico (1º campo), ordem (2º), DV (3º),
 * CNAE fiscal principal (12º) e CNAE fiscal secundária (13º, códigos separados por vírgula).
 */
const COL_ESTAB = {
  CNAE_PRINCIPAL: 11,
  CNAE_SECUNDARIA: 12,
} as const;

/** Início de toda linha válida de Estabelecimentos: "CNPJ_BASICO";"ORDEM";"DV"; */
const PREFIXO_ESTABELECIMENTO = /^"\d{8}";"\d{4}";"\d{2}";/;

/** Separador seguro entre campos: há ";" dentro de alguns campos de texto (complemento, logradouro). */
const SEPARADOR_CAMPOS = '";"';

const CODIGO_CNAE = /^\d{7}$/;

/**
 * Grava as CNAEs de um CNPJ nos fornecedores informados.
 * As descrições são buscadas na DW_FORNECEDORES_CNAE_RF; código sem descrição cadastrada é gravado sozinho.
 * Binds (posicionais): 1 código principal | 2 JSON com os códigos secundários | 3 JSON com as PKs.
 */
const SQL_ATUALIZAR_CNAES = `
DECLARE
  v_cod      VARCHAR2(7) := :1;
  v_cods_sec VARCHAR2(32767) := :2;
  v_pks      VARCHAR2(32767) := :3;
  v_desc     DW.DW_FORNECEDORES_CNAE_RF.DESCRICAO%TYPE;
  v_sec      CLOB;
BEGIN
  IF v_cod IS NOT NULL THEN
    SELECT MAX(DESCRICAO)
      INTO v_desc
      FROM DW.DW_FORNECEDORES_CNAE_RF
     WHERE C_FORNECEDORES_CNAE_PK = v_cod;
  END IF;

  FOR r IN (SELECT t.cod, c.DESCRICAO
              FROM JSON_TABLE(v_cods_sec, '$[*]'
                     COLUMNS (ord FOR ORDINALITY, cod VARCHAR2(7) PATH '$')) t
              LEFT JOIN DW.DW_FORNECEDORES_CNAE_RF c
                ON c.C_FORNECEDORES_CNAE_PK = t.cod
             ORDER BY t.ord) LOOP
    v_sec := v_sec
          || CASE WHEN v_sec IS NOT NULL THEN '; ' END
          || r.cod
          || CASE WHEN r.DESCRICAO IS NOT NULL THEN ' - ' || r.DESCRICAO END;
  END LOOP;

  UPDATE DW.DW_FORNECEDORES
     SET C_CNAE_PRINCIPAL_RECEITA_FEDERAL   = v_cod || CASE WHEN v_desc IS NOT NULL THEN ' - ' || v_desc END,
         A_CNAE_SECUNDARIAS_RECEITA_FEDERAL = v_sec
   WHERE N_FORNECEDOR_PK IN (SELECT pk
                               FROM JSON_TABLE(v_pks, '$[*]' COLUMNS (pk NUMBER PATH '$')));
END;`;

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectRepository(FornecedorModel, 'DW_PROD')
    private readonly fornecedorRepository: Repository<FornecedorModel>,
  ) {}

  /**
   * Processa os arquivos da Receita Federal da competência (AAAA-MM) informada:
   * Simples/MEI, tabela de CNAEs e CNAEs dos estabelecimentos.
   * Retorna a quantidade de fornecedores distintos atualizados e os CNPJs não encontrados.
   */
  async runTask(competencia: string): Promise<ResultadoTask> {
    // Precisa terminar antes do restante: garante a DW_FORNECEDORES atualizada para o cruzamento.
    await this.atualizarCadastroFornecedores();

    const fornecedores = await this.carregarCnpjsFornecedores();
    if (fornecedores.length === 0) {
      this.logger.warn('Nenhum fornecedor com CNPJ válido encontrado.');
    }

    const pastaTemp = await mkdtemp(join(tmpdir(), 'receita-'));

    try {
      const simples = await this.processarSimples(
        competencia,
        pastaTemp,
        fornecedores,
      );
      await this.atualizarTabelaCnaes(competencia, pastaTemp);
      const estabelecimentos = await this.processarEstabelecimentos(
        competencia,
        pastaTemp,
        fornecedores,
      );

      const atualizados = new Set([
        ...simples.atualizados,
        ...estabelecimentos.atualizados,
      ]).size;
      this.logger.log(
        `${atualizados} fornecedores atualizados (competência ${competencia}).`,
      );
      return {
        fornecedoresAtualizados: atualizados,
        cnpjsNaoEncontrados: this.descreverNaoEncontrados(
          simples.naoEncontrados,
          estabelecimentos.naoEncontrados,
        ),
      };
    } finally {
      await rm(pastaTemp, { recursive: true, force: true });
    }
  }

  /**
   * Executa DW.PKG_DW_FORNECEDORES.P_EXECUTA_PROCESSO para os últimos 12 meses fechados.
   * A procedure faz commit internamente e lança erro (ORA-20001) se alguma etapa falhar,
   * o que interrompe a task e é registrado como ERRO no log.
   */
  private async atualizarCadastroFornecedores(): Promise<void> {
    const { inicio, fimExclusivo } = periodoUltimos12Meses();
    this.logger.log(
      `Executando PKG_DW_FORNECEDORES.P_EXECUTA_PROCESSO (${inicio} a ${fimExclusivo}, fim exclusivo)`,
    );

    const inicioExecucao = Date.now();
    await this.fornecedorRepository.query(
      `BEGIN
         DW.PKG_DW_FORNECEDORES.P_EXECUTA_PROCESSO(
           p_dt_inicio => TO_DATE(:1, 'YYYY-MM-DD'),
           p_dt_fim    => TO_DATE(:2, 'YYYY-MM-DD')
         );
       END;`,
      [inicio, fimExclusivo],
    );

    const segundos = Math.round((Date.now() - inicioExecucao) / 1000);
    this.logger.log(`P_EXECUTA_PROCESSO concluída em ${segundos}s.`);
  }

  // ---------------------------------------------------------------------------
  // Simples / MEI
  // ---------------------------------------------------------------------------

  /**
   * Cruza o Simples.zip com os fornecedores pelo CNPJ básico.
   * Retorna as PKs atualizadas e os CNPJs completos cujo básico não está no arquivo.
   */
  private async processarSimples(
    competencia: string,
    pastaTemp: string,
    fornecedores: CnpjFornecedor[],
  ): Promise<ResultadoCruzamento> {
    const pksPorCnpjBasico = this.agruparPorCnpj(fornecedores, 8);
    if (pksPorCnpjBasico.size === 0) {
      return { atualizados: new Set(), naoEncontrados: [] };
    }

    const caminhoZip = await this.baixarArquivoReceita(
      competencia,
      'Simples.zip',
      pastaTemp,
    );

    try {
      const encontrados = await this.buscarNoArquivo(
        this.lerLinhasDoZip(caminhoZip),
        pksPorCnpjBasico,
      );
      this.logger.log(
        `Simples: ${encontrados.size} de ${pksPorCnpjBasico.size} CNPJs básicos encontrados no arquivo.`,
      );

      const atualizados = await this.atualizarFornecedores(
        encontrados,
        pksPorCnpjBasico,
      );
      this.logger.log(`Simples: ${atualizados.size} fornecedores atualizados.`);

      const naoEncontrados = [
        ...new Set(
          fornecedores
            .filter(({ cnpj }) => !encontrados.has(cnpj.slice(0, 8)))
            .map(({ cnpj }) => cnpj),
        ),
      ].sort();
      this.avisarNaoEncontrados('Simples', naoEncontrados);

      return { atualizados, naoEncontrados };
    } finally {
      await rm(caminhoZip, { force: true });
    }
  }

  /** Lê o CSV linha a linha e extrai os dados dos CNPJs básicos de interesse. */
  private async buscarNoArquivo(
    linhas: AsyncIterable<string>,
    cnpjsDeInteresse: Map<string, number[]>,
  ): Promise<Map<string, DadosSimples>> {
    const encontrados = new Map<string, DadosSimples>();

    for await (const linha of linhas) {
      // Checa só o 1º campo antes de quebrar a linha inteira (arquivo tem dezenas de milhões de linhas).
      const fimCnpj = linha.indexOf(';');
      if (fimCnpj < 0) continue;
      const cnpjBasico = this.limparCampo(linha.slice(0, fimCnpj));
      if (!cnpjsDeInteresse.has(cnpjBasico)) continue;

      const campos = linha.split(';').map((c) => this.limparCampo(c));
      encontrados.set(cnpjBasico, {
        simplesReceitaFederal: this.texto(campos[COL.OPCAO_SIMPLES]),
        simplesInclusao: this.data(campos[COL.DATA_OPCAO_SIMPLES]),
        simplesSaida: this.data(campos[COL.DATA_EXCLUSAO_SIMPLES]),
        meiReceitaFederal: this.texto(campos[COL.OPCAO_MEI]),
        meiInclusao: this.data(campos[COL.DATA_OPCAO_MEI]),
        meiSaida: this.data(campos[COL.DATA_EXCLUSAO_MEI]),
      });

      if (encontrados.size === cnpjsDeInteresse.size) break;
    }

    return encontrados;
  }

  private async atualizarFornecedores(
    encontrados: Map<string, DadosSimples>,
    pksPorCnpjBasico: Map<string, number[]>,
  ): Promise<Set<number>> {
    const atualizados = new Set<number>();

    await this.fornecedorRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(FornecedorModel);
      for (const [cnpjBasico, dados] of encontrados) {
        const pks = pksPorCnpjBasico.get(cnpjBasico) ?? [];
        if (pks.length === 0) continue;

        await repo.update({ fornecedorPk: In(pks) }, dados);
        pks.forEach((pk) => atualizados.add(pk));
      }
    });

    return atualizados;
  }

  // ---------------------------------------------------------------------------
  // CNAEs
  // ---------------------------------------------------------------------------

  /**
   * Carrega o Cnaes.zip na DW_FORNECEDORES_CNAE_RF via MERGE:
   * insere CNAEs novas e atualiza a descrição das existentes, sem remover nenhuma.
   */
  private async atualizarTabelaCnaes(
    competencia: string,
    pastaTemp: string,
  ): Promise<void> {
    const caminhoZip = await this.baixarArquivoReceita(
      competencia,
      'Cnaes.zip',
      pastaTemp,
    );

    try {
      let total = 0;

      await this.fornecedorRepository.manager.transaction(async (manager) => {
        // Map evita código repetido no mesmo MERGE (ORA-30926).
        let lote = new Map<string, string>();

        for await (const linha of this.lerLinhasDoZip(caminhoZip)) {
          const campos = linha.trim().slice(1, -1).split(SEPARADOR_CAMPOS);
          if (campos.length !== 2) continue;

          const codigo = campos[0].trim();
          const descricao = campos[1].replace(/""/g, '"').trim().slice(0, 255);
          if (!CODIGO_CNAE.test(codigo) || !descricao) continue;

          lote.set(codigo, descricao);
          if (lote.size >= TAMANHO_LOTE_CNAES) {
            total += await this.gravarLoteCnaes(manager, lote);
            lote = new Map();
          }
        }
        total += await this.gravarLoteCnaes(manager, lote);

        if (total === 0) {
          throw new Error('Nenhuma CNAE válida encontrada no Cnaes.zip.');
        }
      });

      this.logger.log(`${total} CNAEs carregadas na DW_FORNECEDORES_CNAE_RF.`);
    } finally {
      await rm(caminhoZip, { force: true });
    }
  }

  private async gravarLoteCnaes(
    manager: EntityManager,
    lote: Map<string, string>,
  ): Promise<number> {
    if (lote.size === 0) return 0;

    const cnaes = [...lote].map(([codigo, descricao]) => ({
      codigo,
      descricao,
    }));
    await manager.getRepository(CnaeRfModel).upsert(cnaes, ['codigo']);
    return cnaes.length;
  }

  /**
   * Percorre os arquivos de Estabelecimentos um por vez (baixa, cruza, grava e apaga)
   * buscando as CNAEs dos fornecedores pelo CNPJ completo.
   * Retorna as PKs atualizadas e os CNPJs que não estavam em nenhum arquivo.
   */
  private async processarEstabelecimentos(
    competencia: string,
    pastaTemp: string,
    fornecedores: CnpjFornecedor[],
  ): Promise<ResultadoCruzamento> {
    const pendentes = this.agruparPorCnpj(fornecedores, 14);
    const atualizados = new Set<number>();
    if (pendentes.size === 0) return { atualizados, naoEncontrados: [] };

    const arquivos = await this.listarArquivosEstabelecimentos(competencia);

    for (const nomeArquivo of arquivos) {
      if (pendentes.size === 0) {
        this.logger.log(
          'Todos os CNPJs já foram encontrados. Arquivos de Estabelecimentos restantes ignorados.',
        );
        break;
      }

      const caminhoZip = await this.baixarArquivoReceita(
        competencia,
        nomeArquivo,
        pastaTemp,
      );

      try {
        const encontrados = await this.buscarCnaesNoArquivo(
          this.lerLinhasDoZip(caminhoZip),
          pendentes,
        );
        const pks = await this.atualizarCnaesFornecedores(
          encontrados,
          pendentes,
        );

        pks.forEach((pk) => atualizados.add(pk));
        for (const cnpj of encontrados.keys()) pendentes.delete(cnpj);

        this.logger.log(
          `${nomeArquivo}: ${encontrados.size} CNPJs encontrados, ${pendentes.size} pendentes.`,
        );
      } finally {
        await rm(caminhoZip, { force: true });
      }
    }

    this.logger.log(`CNAEs: ${atualizados.size} fornecedores atualizados.`);

    const naoEncontrados = [...pendentes.keys()].sort();
    this.avisarNaoEncontrados(
      'Estabelecimentos',
      naoEncontrados,
      'CNAEs mantidas',
    );

    return { atualizados, naoEncontrados };
  }

  /** Lê o arquivo de Estabelecimentos e extrai as CNAEs dos CNPJs pendentes. */
  private async buscarCnaesNoArquivo(
    linhas: AsyncIterable<string>,
    pendentes: Map<string, number[]>,
  ): Promise<Map<string, DadosCnae>> {
    const encontrados = new Map<string, DadosCnae>();

    for await (const linha of linhas) {
      // CNPJ completo em posições fixas ("XXXXXXXX";"XXXX";"XX";...): evita quebrar
      // a linha inteira nas dezenas de milhões de estabelecimentos que não interessam.
      const cnpj =
        linha.slice(1, 9) + linha.slice(12, 16) + linha.slice(19, 21);
      if (!pendentes.has(cnpj) || encontrados.has(cnpj)) continue;
      if (!PREFIXO_ESTABELECIMENTO.test(linha)) continue;

      const campos = linha.slice(1, -1).split(SEPARADOR_CAMPOS);
      if (campos.length <= COL_ESTAB.CNAE_SECUNDARIA) {
        this.logger.warn(
          `Linha do CNPJ ${cnpj} com layout inesperado. Ignorada.`,
        );
        continue;
      }

      const principal = campos[COL_ESTAB.CNAE_PRINCIPAL].trim();
      encontrados.set(cnpj, {
        principal: CODIGO_CNAE.test(principal) ? principal : null,
        secundarias: campos[COL_ESTAB.CNAE_SECUNDARIA]
          .split(',')
          .map((codigo) => codigo.trim())
          .filter((codigo) => CODIGO_CNAE.test(codigo)),
      });

      if (encontrados.size === pendentes.size) break;
    }

    return encontrados;
  }

  /** Grava as CNAEs encontradas num arquivo (uma transação por arquivo). Retorna as PKs atualizadas. */
  private async atualizarCnaesFornecedores(
    encontrados: Map<string, DadosCnae>,
    pksPorCnpj: Map<string, number[]>,
  ): Promise<Set<number>> {
    const atualizados = new Set<number>();
    if (encontrados.size === 0) return atualizados;

    await this.fornecedorRepository.manager.transaction(async (manager) => {
      for (const [cnpj, dados] of encontrados) {
        const pks = pksPorCnpj.get(cnpj) ?? [];
        if (pks.length === 0) continue;

        await manager.query(SQL_ATUALIZAR_CNAES, [
          dados.principal,
          JSON.stringify(dados.secundarias),
          JSON.stringify(pks),
        ]);
        pks.forEach((pk) => atualizados.add(pk));
      }
    });

    return atualizados;
  }

  // ---------------------------------------------------------------------------
  // Utilitários
  // ---------------------------------------------------------------------------

  /**
   * Carrega os fornecedores com CNPJ válido (14 dígitos, sem formatação).
   * Fornecedores com CPF são ignorados, pois os arquivos só contêm CNPJs.
   */
  private async carregarCnpjsFornecedores(): Promise<CnpjFornecedor[]> {
    const fornecedores = await this.fornecedorRepository.find({
      select: { fornecedorPk: true, cnpjCpf: true },
    });

    return fornecedores
      .map(({ fornecedorPk, cnpjCpf }) => ({
        fornecedorPk,
        cnpj: cnpjCpf.replace(/\D/g, ''),
      }))
      .filter(({ cnpj }) => cnpj.length === 14);
  }

  /** Mapeia CNPJ (básico com 8 dígitos ou completo com 14) -> PKs (N_FORNECEDOR_PK) dos fornecedores. */
  private agruparPorCnpj(
    fornecedores: CnpjFornecedor[],
    digitosChave: 8 | 14,
  ): Map<string, number[]> {
    const mapa = new Map<string, number[]>();
    for (const { fornecedorPk, cnpj } of fornecedores) {
      const chave = cnpj.slice(0, digitosChave);
      const pks = mapa.get(chave);
      if (pks) pks.push(fornecedorPk);
      else mapa.set(chave, [fornecedorPk]);
    }
    return mapa;
  }

  /** Registra no console os CNPJs não encontrados numa origem (Simples ou Estabelecimentos). */
  private avisarNaoEncontrados(
    origem: string,
    cnpjs: string[],
    observacao?: string,
  ): void {
    if (cnpjs.length === 0) return;

    const complemento = observacao ? ` (${observacao})` : '';
    this.logger.warn(
      `${origem}: ${cnpjs.length} CNPJs não encontrados${complemento}: ` +
        cnpjs.map((cnpj) => this.formatarCnpj(cnpj)).join(', '),
    );
  }

  /**
   * Texto da coluna A_CNPJS_NAO_ENCONTRADOS do log:
   * "12.345.678/0001-90 (Simples); 98.765.432/0001-10 (Estabelecimentos)". Null se a lista estiver vazia.
   */
  private descreverNaoEncontrados(
    simples: string[],
    estabelecimentos: string[],
  ): string | null {
    const itens = [
      ...simples.map((cnpj) => `${this.formatarCnpj(cnpj)} (Simples)`),
      ...estabelecimentos.map(
        (cnpj) => `${this.formatarCnpj(cnpj)} (Estabelecimentos)`,
      ),
    ];
    return itens.length > 0 ? itens.join('; ') : null;
  }

  /** Formata 14 dígitos como 00.000.000/0000-00. */
  private formatarCnpj(cnpj: string): string {
    return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12, 14)}`;
  }

  /**
   * Lista (PROPFIND WebDAV, Depth 1) a pasta da competência e retorna os arquivos
   * Estabelecimentos<n>.zip em ordem numérica (0, 1, ..., 9, 10...). Erro se não houver nenhum.
   */
  private async listarArquivosEstabelecimentos(
    competencia: string,
  ): Promise<string[]> {
    const url = `${URL_BASE_RECEITA}/${competencia}/`;
    this.logger.log(`Listando ${url}`);

    const resposta = await fetch(url, {
      method: 'PROPFIND',
      headers: { Depth: '1' },
    });
    if (!resposta.ok) {
      throw new Error(
        `Falha ao listar ${url}: HTTP ${resposta.status} ${resposta.statusText}`,
      );
    }

    const xml = await resposta.text();
    const arquivos = new Map<number, string>();
    for (const [, href] of xml.matchAll(HREF_WEBDAV)) {
      const nome = decodeURIComponent(href.trim().split('/').pop() ?? '');
      const numero = PADRAO_ARQUIVO_ESTABELECIMENTOS.exec(nome)?.[1];
      if (numero !== undefined) arquivos.set(Number(numero), nome);
    }

    if (arquivos.size === 0) {
      throw new Error(
        `Nenhum arquivo Estabelecimentos<n>.zip encontrado na competência ${competencia} (${url}).`,
      );
    }

    const nomes = [...arquivos]
      .sort(([a], [b]) => a - b)
      .map(([, nome]) => nome);
    this.logger.log(
      `${nomes.length} arquivos de Estabelecimentos encontrados: ${nomes.join(', ')}.`,
    );
    return nomes;
  }

  /** Baixa um arquivo da pasta da competência na Receita. Erro se não existir. */
  private async baixarArquivoReceita(
    competencia: string,
    nomeArquivo: string,
    pastaDestino: string,
  ): Promise<string> {
    const url = `${URL_BASE_RECEITA}/${competencia}/${nomeArquivo}`;
    const destino = join(pastaDestino, nomeArquivo);

    const baixou = await this.baixarArquivo(url, destino);
    if (!baixou) {
      throw new Error(
        `Arquivo ${nomeArquivo} da competência ${competencia} não encontrado (${url}).`,
      );
    }
    return destino;
  }

  /**
   * Baixa o zip em stream para o disco, validando o conteúdo, com novas tentativas em caso de falha
   * (o servidor da Receita às vezes responde 200 com conteúdo truncado ou que não é zip).
   * Retorna false se não existir (404).
   */
  private async baixarArquivo(url: string, destino: string): Promise<boolean> {
    for (let tentativa = 1; ; tentativa++) {
      try {
        this.logger.log(
          `Baixando ${url}` +
            (tentativa > 1
              ? ` (tentativa ${tentativa}/${TENTATIVAS_DOWNLOAD})`
              : ''),
        );
        return await this.baixarArquivoUmaVez(url, destino);
      } catch (erro: unknown) {
        await rm(destino, { force: true });
        const motivo = erro instanceof Error ? erro.message : String(erro);
        if (tentativa >= TENTATIVAS_DOWNLOAD) {
          throw new Error(
            `Falha ao baixar ${url} após ${TENTATIVAS_DOWNLOAD} tentativas: ${motivo}`,
          );
        }

        const espera = ESPERA_ENTRE_TENTATIVAS_MS * tentativa;
        this.logger.warn(
          `Download de ${url} falhou (${motivo}). Nova tentativa em ${espera / 1000}s.`,
        );
        await setTimeout(espera);
      }
    }
  }

  private async baixarArquivoUmaVez(
    url: string,
    destino: string,
  ): Promise<boolean> {
    const resposta = await fetch(url);

    if (resposta.status === 404) return false;
    if (!resposta.ok || !resposta.body) {
      throw new Error(`HTTP ${resposta.status} ${resposta.statusText}`);
    }

    await pipeline(
      Readable.fromWeb(resposta.body as unknown as WebReadableStream),
      createWriteStream(destino),
    );

    await this.validarZipBaixado(
      destino,
      Number(resposta.headers.get('content-length') ?? NaN),
      resposta.headers.get('content-type'),
    );
    return true;
  }

  /**
   * Confere o arquivo baixado: tamanho igual ao Content-Length, assinatura de zip no início
   * e registro "End of central directory" no fim (ausente quando o arquivo vem truncado).
   */
  private async validarZipBaixado(
    caminho: string,
    tamanhoEsperado: number,
    contentType: string | null,
  ): Promise<void> {
    const { size } = await stat(caminho);
    if (Number.isFinite(tamanhoEsperado) && size !== tamanhoEsperado) {
      throw new Error(
        `arquivo incompleto: ${size} de ${tamanhoEsperado} bytes recebidos`,
      );
    }

    const arquivo = await open(caminho, 'r');
    try {
      const { buffer, bytesRead } = await arquivo.read(
        Buffer.alloc(200),
        0,
        200,
        0,
      );
      const inicio = buffer.subarray(0, bytesRead);
      if (!inicio.subarray(0, 4).equals(ASSINATURA_ZIP)) {
        const trecho = inicio.toString('latin1').replace(/\s+/g, ' ').trim();
        throw new Error(
          `conteúdo recebido não é zip (${size} bytes, Content-Type ${contentType ?? 'ausente'}): "${trecho}"`,
        );
      }

      // O registro fica nos últimos 22 bytes, mais até 64 KB de comentário do zip.
      const tamanhoFim = Math.min(size, TAMANHO_MAX_FIM_ZIP);
      const fim = await arquivo.read(
        Buffer.alloc(tamanhoFim),
        0,
        tamanhoFim,
        size - tamanhoFim,
      );
      if (!fim.buffer.subarray(0, fim.bytesRead).includes(ASSINATURA_FIM_ZIP)) {
        throw new Error(
          `zip truncado: fim do arquivo não encontrado (${size} bytes recebidos)`,
        );
      }
    } finally {
      await arquivo.close();
    }
  }

  /**
   * Lê linha a linha (latin1) o primeiro arquivo (não diretório) do zip, descompactando em stream,
   * sem gravar o conteúdo extraído em disco. Interromper a leitura fecha o stream e o zip.
   */
  private async *lerLinhasDoZip(caminhoZip: string): AsyncGenerator<string> {
    const zip = await yauzl.openPromise(caminhoZip);

    try {
      for await (const entry of zip.eachEntry()) {
        if (entry.fileName.endsWith('/')) continue;

        this.logger.log(`Lendo ${entry.fileName}`);
        const stream = await zip.openReadStreamPromise(entry);
        const linhas = createInterface({
          input: stream.setEncoding('latin1'),
          crlfDelay: Infinity,
        });

        try {
          for await (const linha of linhas) yield linha;
        } finally {
          linhas.close();
          stream.destroy();
        }
        return;
      }
    } finally {
      if (zip.isOpen) zip.close();
    }

    throw new Error(`Nenhum arquivo encontrado dentro de ${caminhoZip}`);
  }

  private limparCampo(valor: string): string {
    return valor.trim().replace(/^"|"$/g, '');
  }

  private texto(valor: string | undefined): string | null {
    return valor ? valor : null;
  }

  /** Converte AAAAMMDD em Date; "00000000" ou vazio vira null. */
  private data(valor: string | undefined): Date | null {
    if (!valor || !/^\d{8}$/.test(valor) || valor === '00000000') return null;

    const ano = Number(valor.slice(0, 4));
    const mes = Number(valor.slice(4, 6));
    const dia = Number(valor.slice(6, 8));
    const data = new Date(ano, mes - 1, dia);

    return data.getMonth() === mes - 1 ? data : null;
  }
}
