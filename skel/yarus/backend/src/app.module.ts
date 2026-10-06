import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { AuthGuard } from './auth';
import { YarusService } from './yarus.service';
import { ExtendService } from './extend.service';
import { YarusController } from './yarus.controller';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { ExtendController } from './extend.controller';
import { WaveService } from './wave.service';
import { WaveController } from './wave.controller';
import { OpsService } from './ops.service';
import { OpsController } from './ops.controller';
import { ExtraService } from './extra.service';
import { ExtraController } from './extra.controller';
import { V1Controller } from './v1.controller';
import { ExchangeService } from './exchange.service';
import { ExchangeController } from './exchange.controller';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'yarus-dev-jwt-secret-change',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [YarusController, ExtendController, WaveController, OpsController, ExtraController, V1Controller, ExchangeController, PlatformController],
  providers: [
    PrismaService,
    YarusService,
    ExtendService,
    WaveService,
    OpsService,
    ExtraService,
    ExchangeService,
    PlatformService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
