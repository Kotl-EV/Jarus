import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser } from './auth';
import { PrismaService } from './prisma.service';
import { YarusService } from './yarus.service';
import { isClient } from './permissions';

@ApiTags('v1-1c')
@ApiBearerAuth()
@Controller('v1')
export class V1Controller {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(YarusService) private yarus: YarusService,
  ) {}

  private async idem<T>(user: Authed, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const hit = await this.prisma.idempotencyRecord.findUnique({
      where: { tenantId_key: { tenantId: user.tenantId, key } },
    });
    if (hit) return JSON.parse(hit.response) as T;
    const result = await fn();
    await this.prisma.idempotencyRecord.create({
      data: { tenantId: user.tenantId, key, response: JSON.stringify(result) },
    });
    return result;
  }

  @Get('ping')
  ping(@CurrentUser() user: Authed) {
    return { ok: true, tenant: user.tenantName, role: user.role, api: 'v1' };
  }

  @Get('products')
  products(@CurrentUser() user: Authed, @Query('q') q?: string) {
    return this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        archived: false,
        ...(q ? { OR: [{ sku: { contains: q } }, { name: { contains: q } }] } : {}),
      },
      include: { barcodes: true },
      take: 500,
    });
  }

  @Patch('products/:id')
  patchProduct(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.prisma.product.update({
      where: { id },
      data: {
        name: body.name ? String(body.name) : undefined,
        weightG: body.weightG != null ? Number(body.weightG) : undefined,
        articleMp: body.articleMp ? String(body.articleMp) : undefined,
      },
    });
  }

  @Get('stock')
  stock(@CurrentUser() user: Authed) {
    return this.prisma.stockBalance.findMany({
      where: { tenantId: user.tenantId, qty: { not: 0 } },
      include: { product: true, cell: true },
    });
  }

  @Get('requests')
  requests(@CurrentUser() user: Authed) {
    return this.prisma.request.findMany({
      where: { tenantId: user.tenantId },
      include: { lines: true, type: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('requests')
  createRequest(
    @CurrentUser() user: Authed,
    @Headers('idempotency-key') idem: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.idem(user, idem, () => this.yarus.createRequest(user, body));
  }

  @Get('invoices')
  invoices(@CurrentUser() user: Authed) {
    return this.prisma.invoice.findMany({
      where: { tenantId: user.tenantId, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
      include: { payments: true, client: true },
    });
  }

  @Get('fbs')
  fbs(@CurrentUser() user: Authed) {
    return this.prisma.marketplaceOrder.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('cis')
  cis(@CurrentUser() user: Authed, @Headers('idempotency-key') idem: string, @Body() body: { codes: string[]; productId?: string }) {
    return this.idem(user, idem, () => this.yarus.importCis(user, body.codes || [], body.productId));
  }
}
