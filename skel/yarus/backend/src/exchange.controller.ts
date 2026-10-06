import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser, Perm, Public } from './auth';
import { ExchangeService } from './exchange.service';

@ApiTags('exchange')
@ApiBearerAuth()
@Controller()
export class ExchangeController {
  constructor(@Inject(ExchangeService) private ex: ExchangeService) {}

  @Public()
  @Post('auth/pin')
  pin(@Body() body: { slug: string; pin: string }) {
    return this.ex.loginPin(body.slug, body.pin);
  }

  @Post('employees/:id/pin')
  @Perm('users')
  setPin(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { pin: string }) {
    return this.ex.setPin(user, id, body.pin);
  }

  @Get('exchange/1c/catalog')
  catalog(@CurrentUser() user: Authed) {
    return this.ex.catalogXml(user);
  }

  @Get('exchange/1c/stock')
  stock(@CurrentUser() user: Authed) {
    return this.ex.stockXml(user);
  }

  @Post('print-jobs/enqueue')
  enqueue(@CurrentUser() user: Authed, @Body() body: { zpl: string; copies?: number }) {
    return this.ex.enqueueZpl(user, body.zpl, body.copies || 1);
  }

  @Get('print-jobs/next')
  next(@CurrentUser() user: Authed) {
    return this.ex.claimJob(user);
  }

  @Post('print-jobs/:id/done')
  done(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { ok?: boolean }) {
    return this.ex.finishJob(user, id, body.ok !== false);
  }

  @Get('usage')
  usage(@CurrentUser() user: Authed) {
    return this.ex.usage(user);
  }
}
