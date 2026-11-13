import { TaskFornecedoresLogModel } from '../models/task-fornecedores-log.model';

/** Campos gravados ao finalizar uma execução no log. */
export type ResultadoLog = Pick<
  TaskFornecedoresLogModel,
  'status' | 'fornecedoresAtualizados' | 'motivoErro'
>;
