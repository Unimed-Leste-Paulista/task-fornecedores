import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaskFornecedoresLogModel } from './models/task-fornecedores-log.model';
import { TaskService } from './task.service';
import type { OrigemExecucao } from './types/origem-execucao.type';
import type { ResultadoLog } from './types/resultado-log.type';
import { competenciaMesAnterior } from './utils/competencia.util';

/**
 * Agenda a task:
 * - executa imediatamente ao subir a aplicação;
 * - todo dia à meia-noite consulta o log e, se a competência ainda não teve
 *   execução com sucesso (dia 1, falha anterior ou arquivo não publicado), executa.
 */
@Injectable()
export class TaskScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(TaskScheduler.name);
  /** Evita duas execuções simultâneas no mesmo processo (ex.: subida perto da meia-noite). */
  private emExecucao = false;

  constructor(
    private readonly taskService: TaskService,
    @InjectRepository(TaskFornecedoresLogModel, 'TIULP')
    private readonly logRepository: Repository<TaskFornecedoresLogModel>,
  ) {}

  onApplicationBootstrap(): void {
    void this.executar('INICIALIZACAO');
  }

  @Cron('0 0 * * *', {
    name: 'task-fornecedores',
    timeZone: 'America/Sao_Paulo',
  })
  async executarAgendado(): Promise<void> {
    const competencia = competenciaMesAnterior();
    if (await this.competenciaConcluida(competencia)) return;
    await this.executar('CRON');
  }

  private async executar(origem: OrigemExecucao): Promise<void> {
    if (this.emExecucao) {
      this.logger.warn('Task já está em execução. Ignorando disparo.');
      return;
    }

    this.emExecucao = true;
    await this.encerrarExecucoesInterrompidas();

    const competencia = competenciaMesAnterior();
    const inicio = new Date();
    const logId = await this.iniciarLog(competencia, origem, inicio);

    try {
      const resultado = await this.taskService.runTask(competencia);
      await this.finalizarLog(logId, competencia, origem, inicio, {
        status: 'SUCESSO',
        fornecedoresAtualizados: resultado.fornecedoresAtualizados,
        motivoErro: null,
        cnpjsNaoEncontrados: resultado.cnpjsNaoEncontrados,
      });
    } catch (erro: unknown) {
      this.logger.error(
        'Falha na execução da task. Nova tentativa na próxima meia-noite.',
        erro instanceof Error ? erro.stack : erro,
      );
      await this.finalizarLog(logId, competencia, origem, inicio, {
        status: 'ERRO',
        fornecedoresAtualizados: null,
        motivoErro: this.descreverErro(erro),
        cnpjsNaoEncontrados: null,
      });
    } finally {
      this.emExecucao = false;
    }
  }

  /**
   * Verifica no log se a competência já foi processada com sucesso.
   * Se a consulta falhar, considera pendente: reprocessar é seguro (o update é idempotente).
   */
  private async competenciaConcluida(competencia: string): Promise<boolean> {
    try {
      return await this.logRepository.exists({
        where: { competencia, status: 'SUCESSO' },
      });
    } catch (erro: unknown) {
      this.logger.warn(
        `Não foi possível consultar o log da competência ${competencia}. Executando mesmo assim.`,
        erro instanceof Error ? erro.stack : erro,
      );
      return false;
    }
  }

  /**
   * Marca como ERRO as linhas que ficaram EM_EXECUCAO porque o processo morreu
   * antes de finalizar (deploy, restart, SIGKILL, falta de memória...).
   * Só é seguro porque roda com a trava `emExecucao` já adquirida e assume
   * uma única instância da aplicação: nenhuma execução legítima está em andamento.
   * D_FIM_EXECUCAO fica nulo, pois não se sabe quando o processo caiu.
   */
  private async encerrarExecucoesInterrompidas(): Promise<void> {
    try {
      const resultado = await this.logRepository.update(
        { status: 'EM_EXECUCAO' },
        {
          status: 'ERRO',
          motivoErro:
            'Execução interrompida: o processo foi encerrado antes de finalizar a task.',
        },
      );

      if (resultado.affected) {
        this.logger.warn(
          `${resultado.affected} execução(ões) interrompida(s) marcada(s) como ERRO no log.`,
        );
      }
    } catch (erro: unknown) {
      this.logger.error(
        'Não foi possível encerrar execuções interrompidas no log da TIULP',
        erro instanceof Error ? erro.stack : erro,
      );
    }
  }

  /** Grava o registro EM_EXECUCAO e retorna a PK gerada pelo trigger, ou null se falhar. */
  private async iniciarLog(
    competencia: string,
    origem: OrigemExecucao,
    inicio: Date,
  ): Promise<number | null> {
    try {
      const resultado = await this.logRepository.insert({
        competencia,
        origem,
        inicioExecucao: inicio,
        status: 'EM_EXECUCAO',
      });
      const id = resultado.identifiers[0]?.taskFornecedoresLogPk as
        number | undefined;
      return id ?? null;
    } catch (erro: unknown) {
      this.logger.error(
        'Não foi possível gravar o início da execução na TIULP',
        erro instanceof Error ? erro.stack : erro,
      );
      return null;
    }
  }

  /**
   * Atualiza o registro iniciado. Se o início não foi gravado, insere o registro completo.
   * Falha ao gravar o log não derruba a aplicação nem muda o resultado da task.
   */
  private async finalizarLog(
    logId: number | null,
    competencia: string,
    origem: OrigemExecucao,
    inicio: Date,
    resultado: ResultadoLog,
  ): Promise<void> {
    const dados = { ...resultado, fimExecucao: new Date() };

    try {
      if (logId !== null) {
        await this.logRepository.update(
          { taskFornecedoresLogPk: logId },
          dados,
        );
      } else {
        await this.logRepository.insert({
          ...dados,
          competencia,
          origem,
          inicioExecucao: inicio,
        });
      }
    } catch (erro: unknown) {
      this.logger.error(
        'Não foi possível gravar o fim da execução na TIULP',
        erro instanceof Error ? erro.stack : erro,
      );
    }
  }

  private descreverErro(erro: unknown): string {
    if (erro instanceof Error)
      return erro.stack ?? `${erro.name}: ${erro.message}`;
    return String(erro);
  }
}
