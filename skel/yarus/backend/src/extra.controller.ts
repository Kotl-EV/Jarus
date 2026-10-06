import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser, Public } from './auth';
import { ExtraService } from './extra.service';
import { PrismaService } from './prisma.service';

@ApiTags('extra')
@ApiBearerAuth()
@Controller()
export class ExtraController {
  constructor(
    @Inject(ExtraService) private extra: ExtraService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  @Post('bank/pay')
  pay(@CurrentUser() user: Authed, @Body() body: { invoiceId: string; amountKop: number; method?: string; comment?: string }) {
    return this.extra.bankPay(user, body);
  }

  @Public()
  @Post('webhooks/bank/:slug')
  bankHook(
    @Param('slug') slug: string,
    @Headers('idempotency-key') idem: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.extra.bankWebhook(slug, idem || String(body.id || Date.now()), body);
  }

  @Public()
  @Post('webhooks/tilda/:slug')
  tilda(@Param('slug') slug: string, @Body() body: Record<string, unknown>) {
    return this.extra.tildaWebhook(slug, body);
  }

  @Post('mailings')
  mail(@CurrentUser() user: Authed, @Body() body: { title: string; body: string; channel?: string; clientId?: string }) {
    return this.extra.mailing(user, body);
  }

  @Get('backup')
  backup(@CurrentUser() user: Authed) {
    return this.extra.backupExport(user);
  }

  @Patch('clients/:id/holding')
  holding(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { holdingId: string | null }) {
    return this.extra.setHolding(user, id, body.holdingId);
  }

  @Patch('clients/:id/prices')
  prices(
    @CurrentUser() user: Authed,
    @Param('id') id: string,
    @Body() body: { storageRateKop?: number; freeStorageDays?: number; priceMarkupPct?: number },
  ) {
    return this.extra.setPrices(user, id, body);
  }

  @Post('invoices/:id/telegram')
  tgDoc(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.extra.telegramInvoice(user, id);
  }

  @Get('invoices/:id/sbp')
  sbp(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.extra.sbpQr(user, id);
  }

  @Post('invoices/recalc')
  recalc(@CurrentUser() user: Authed, @Body() body: { clientId: string; periodFrom: string; periodTo: string }) {
    return this.extra.recalcInvoice(user, body);
  }

  @Post('cis/import-pdf')
  cisPdf(@CurrentUser() user: Authed, @Body() body: { base64: string; productId?: string }) {
    return this.extra.importCisPdf(user, body);
  }

  @Post('products/bind-mp')
  bindMp(@CurrentUser() user: Authed, @Body() body: { barcode: string; articleMp: string }) {
    return this.extra.bindMpBarcode(user, body.barcode, body.articleMp);
  }

  @Post('backup/restore')
  restore(@CurrentUser() user: Authed, @Body() body: { products?: unknown[]; clients?: unknown[] }) {
    return this.extra.backupRestore(user, body);
  }

  @Post('consumables')
  saveCons(@CurrentUser() user: Authed, @Body() body: { id?: string; name: string; sku: string; qty?: number; costKop?: number }) {
    return this.extra.upsertConsumable(user, body);
  }

  @Post('departments')
  dept(@CurrentUser() user: Authed, @Body() body: { name: string }) {
    return this.prisma.department.create({ data: { tenantId: user.tenantId, name: body.name } });
  }

  @Get('departments')
  depts(@CurrentUser() user: Authed) {
    return this.prisma.department.findMany({ where: { tenantId: user.tenantId } });
  }

  @Get('quality')
  quality(@CurrentUser() user: Authed) {
    return this.extra.quality(user);
  }

  @Get('serials')
  serials(@CurrentUser() user: Authed, @Query('productId') productId?: string) {
    return this.prisma.serial.findMany({
      where: { tenantId: user.tenantId, ...(productId ? { productId } : {}) },
      take: 200,
      orderBy: { code: 'asc' },
    });
  }

  @Post('serials')
  addSerial(@CurrentUser() user: Authed, @Body() body: { productId: string; code: string; lotId?: string }) {
    return this.prisma.serial.create({
      data: { tenantId: user.tenantId, productId: body.productId, code: body.code.trim(), lotId: body.lotId },
    });
  }

  @Post('serials/ship')
  async shipSerial(@CurrentUser() user: Authed, @Body() body: { code: string }) {
    const s = await this.prisma.serial.findUnique({
      where: { tenantId_code: { tenantId: user.tenantId, code: body.code } },
    });
    if (!s) throw new Error('Серийник не найден');
    return this.prisma.serial.update({ where: { id: s.id }, data: { status: 'shipped' } });
  }

  @Post('shifts/plan')
  planShift(@CurrentUser() user: Authed, @Body() body: { userId: string; title: string; dueAt: string }) {
    return this.prisma.task.create({
      data: {
        tenantId: user.tenantId,
        userId: body.userId,
        title: body.title,
        kind: 'shift',
        dueAt: new Date(body.dueAt),
      },
    });
  }

  @Post('quote/invoice')
  async quoteInvoice(
    @CurrentUser() user: Authed,
    @Body() body: { clientId: string; items: { serviceCode: string; qty: number }[] },
  ) {
    const q = await this.prisma.service.findMany({ where: { tenantId: user.tenantId } });
    const map = new Map(q.map((s) => [s.code, s]));
    const lines = body.items.map((i) => {
      const s = map.get(i.serviceCode);
      const amountKop = Math.round((s?.priceKop || 0) * i.qty);
      return { title: `${s?.name || i.serviceCode} × ${i.qty}`, amountKop };
    });
    const amountKop = lines.reduce((s, l) => s + l.amountKop, 0);
    const count = await this.prisma.invoice.count({ where: { tenantId: user.tenantId } });
    return this.prisma.invoice.create({
      data: {
        tenantId: user.tenantId,
        clientId: body.clientId,
        number: `КП-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`,
        kind: 'quote',
        status: 'issued',
        amountKop,
        currency: user.currency,
        linesJson: JSON.stringify(lines),
      },
    });
  }
}
