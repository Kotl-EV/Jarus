import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* no .env */
  }
}
loadEnv();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const dataDir = path.join(process.cwd(), '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (process.env.WEB_ORIGIN || 'http://localhost:5173,http://swixy.sknt.ru:5173').split(','),
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, transform: true }));
  const swagger = new DocumentBuilder()
    .setTitle('Ярус WMS API')
    .setDescription('Облачная WMS и операционная система фулфилмента. REST + вебхуки, Idempotency-Key, scopes.')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('api/docs', app, document);
  fs.writeFileSync(path.join(dataDir, 'openapi.json'), JSON.stringify(document, null, 2));
  const port = Number(process.env.PORT || 3001);
  await app.listen(port);
  console.log(`Ярус API http://localhost:${port}/api  docs: /api/docs`);
}

bootstrap();
