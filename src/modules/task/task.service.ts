import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { In, Repository } from 'typeorm';
import * as yauzl from 'yauzl';
import { FornecedorModel } from './models/fornecedor.model';
import { DadosSimples } from './types/dados-simples.type';
import { periodoUltimos12Meses } from './utils/competencia.util';

const URL_BASE_SIMPLES =
  'https://arquivos.receitafederal.gov.br/public.php/dav/files/YggdBLfdninEJX9';

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

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectRepository(FornecedorModel, 'DW_PROD')
    private readonly fornecedorRepository: Repository<FornecedorModel>,
  ) {}

  /**
   * Processa o arquivo do Simples da competência (AAAA-MM) informada.
   * Retorna a quantidade de fornecedores atualizados.
   */
  async runTask(competencia: string): Promise<number> {
    // Precisa terminar antes do restante: garante a DW_FORNECEDORES atualizada para o cruzamento.
    await this.atualizarCadastroFornecedores();

    const url = `${URL_BASE_SIMPLES}/${competencia}/Simples.zip`;
    const pastaTemp = await mkdtemp(join(tmpdir(), 'simples-'));

    try {
      const caminhoZip = join(pastaTemp, 'Simples.zip');
      const baixou = await this.baixarArquivo(url, caminhoZip);
      if (!baixou) {
        throw new Error(
          `Arquivo do Simples da competência ${competencia} não encontrado (${url}).`,
        );
      }

      const caminhoCsv = await this.extrairPrimeiroArquivo(
        caminhoZip,
        pastaTemp,
      );

      const pksPorCnpjBasico = await this.carregarFornecedores();
      if (pksPorCnpjBasico.size === 0) {
        this.logger.warn('Nenhum fornecedor com CNPJ válido encontrado.');
        return 0;
      }

      const encontrados = await this.buscarNoArquivo(
        caminhoCsv,
        pksPorCnpjBasico,
      );
      this.logger.log(
        `${encontrados.size} de ${pksPorCnpjBasico.size} CNPJs básicos encontrados no arquivo.`,
      );

      const atualizados = await this.atualizarFornecedores(
        encontrados,
        pksPorCnpjBasico,
      );
      this.logger.log(
        `${atualizados} fornecedores atualizados (competência ${competencia}).`,
      );
      return atualizados;
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

  /** Baixa o arquivo em stream para o disco. Retorna false se não existir (404). */
  private async baixarArquivo(url: string, destino: string): Promise<boolean> {
    this.logger.log(`Baixando ${url}`);
    const resposta = await fetch(url);

    if (resposta.status === 404) return false;
    if (!resposta.ok || !resposta.body) {
      throw new Error(
        `Falha ao baixar ${url}: HTTP ${resposta.status} ${resposta.statusText}`,
      );
    }

    await pipeline(
      Readable.fromWeb(resposta.body as unknown as WebReadableStream),
      createWriteStream(destino),
    );
    return true;
  }

  /** Extrai para o disco o primeiro arquivo (não diretório) do zip. */
  private async extrairPrimeiroArquivo(
    caminhoZip: string,
    pastaDestino: string,
  ): Promise<string> {
    const zip = await yauzl.openPromise(caminhoZip);

    try {
      for await (const entry of zip.eachEntry()) {
        if (entry.fileName.endsWith('/')) continue;

        const destino = join(pastaDestino, 'Simples.csv');
        this.logger.log(`Extraindo ${entry.fileName}`);
        await pipeline(
          await zip.openReadStreamPromise(entry),
          createWriteStream(destino),
        );
        return destino;
      }
    } finally {
      if (zip.isOpen) zip.close();
    }

    throw new Error(`Nenhum arquivo encontrado dentro de ${caminhoZip}`);
  }

  /**
   * Mapeia CNPJ básico (8 primeiros dígitos) -> PKs (N_FORNECEDOR_PK) dos fornecedores.
   * Fornecedores com CPF são ignorados, pois o arquivo só contém CNPJs.
   */
  private async carregarFornecedores(): Promise<Map<string, number[]>> {
    const fornecedores = await this.fornecedorRepository.find({
      select: { fornecedorPk: true, cnpjCpf: true },
    });

    const mapa = new Map<string, number[]>();
    for (const { fornecedorPk, cnpjCpf } of fornecedores) {
      const digitos = cnpjCpf.replace(/\D/g, '');
      if (digitos.length !== 14) continue;

      const cnpjBasico = digitos.slice(0, 8);
      const pks = mapa.get(cnpjBasico);
      if (pks) pks.push(fornecedorPk);
      else mapa.set(cnpjBasico, [fornecedorPk]);
    }
    return mapa;
  }

  /** Lê o CSV linha a linha e extrai os dados dos CNPJs básicos de interesse. */
  private async buscarNoArquivo(
    caminhoCsv: string,
    cnpjsDeInteresse: Map<string, number[]>,
  ): Promise<Map<string, DadosSimples>> {
    const encontrados = new Map<string, DadosSimples>();
    const linhas = createInterface({
      input: createReadStream(caminhoCsv, { encoding: 'latin1' }),
      crlfDelay: Infinity,
    });

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
  ): Promise<number> {
    let atualizados = 0;

    await this.fornecedorRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(FornecedorModel);
      for (const [cnpjBasico, dados] of encontrados) {
        const pks = pksPorCnpjBasico.get(cnpjBasico) ?? [];
        if (pks.length === 0) continue;

        const resultado = await repo.update({ fornecedorPk: In(pks) }, dados);
        atualizados += resultado.affected ?? pks.length;
      }
    });

    return atualizados;
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
