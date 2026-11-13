import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { config } from 'dotenv';
import { DynamicModule } from '@nestjs/common';
import { inicializarOracleClient } from './oracle-client';

config();
inicializarOracleClient();

export const DW_PROD = (): DynamicModule =>
  TypeOrmModule.forRootAsync({
    name: 'DW_PROD',
    useFactory: (configService: ConfigService) => ({
      type: 'oracle',
      host: configService.get<string>('HOST_DW_PROD'),
      username: configService.get<string>('USER_DW_PROD'),
      password: configService.get<string>('PASSWORD_DW_PROD'),
      port: configService.get<number>('PORT_DW_PROD'),
      serviceName: configService.getOrThrow<string>('SERVICE_NAME_DW_PROD'),
      synchronize: false,
      schema: 'DW',
      // logging: ['query', 'error', 'schema', 'warn', 'info', 'log', 'migration'],
      logging: false,
      logger: 'advanced-console',
      autoLoadEntities: true,
      migrations: [],
    }),
    inject: [ConfigService],
  });

export const TIULP = (): DynamicModule =>
  TypeOrmModule.forRootAsync({
    name: 'TIULP',
    useFactory: (configService: ConfigService) => ({
      type: 'oracle',
      host: configService.get<string>('HOST_TIULP'),
      username: configService.get<string>('USER_TIULP'),
      password: configService.get<string>('PASSWORD_TIULP'),
      port: configService.get<number>('PORT_TIULP'),
      serviceName: configService.getOrThrow<string>('SERVICE_NAME_TIULP'),
      synchronize: false,
      logging: false,
      logger: 'advanced-console',
      autoLoadEntities: true,
      migrations: [],
    }),
    inject: [ConfigService],
  });
