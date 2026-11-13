import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FornecedorModel } from './models/fornecedor.model';
import { TaskFornecedoresLogModel } from './models/task-fornecedores-log.model';
import { TaskScheduler } from './task.scheduler';
import { TaskService } from './task.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([FornecedorModel], 'DW_PROD'),
    TypeOrmModule.forFeature([TaskFornecedoresLogModel], 'TIULP'),
  ],
  providers: [TaskService, TaskScheduler],
})
export class TaskModule {}
