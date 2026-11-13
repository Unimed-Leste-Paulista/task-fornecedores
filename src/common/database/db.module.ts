import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DW_PROD, TIULP } from './db.bases';

@Module({
  imports: [DW_PROD(), TIULP()],
  exports: [TypeOrmModule],
})
export default class DatabaseModule {}
