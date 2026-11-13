import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
  });

  await app.listen(9999, `0.0.0.0`);
}

bootstrap().catch((error) => {
  console.error('Erro durante lançamento da aplicação:', error);
  process.exit(1);
});
