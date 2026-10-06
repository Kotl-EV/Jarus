import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser } from './auth';
import { WaveService } from './wave.service';
import { PrismaService } from './prisma.service';
import { STOCK } from './stock.engine';

@ApiTags('wave')
@ApiBearerAuth()
@Controller()
export class WaveController {
  constructor(
    @Inject(WaveService) private wave: WaveService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  @Get('putaway/recommend')
  recommend(
    @CurrentUser() user: Authed,
    @Query('warehouseId') warehouseId: string,
    @Query('productId') productId: string,
    @Query('qty') qty?: string,
  ) {
    return this.wave.recommend(user, warehouseId, productId, Number(qty || 1));
  }

  @Get('putaway/inbox')
  async inbox(@CurrentUser() user: Authed, @Query('warehouseId') warehouseId: string) {
    const rcv = await this.prisma.cell.findFirst({ where: { tenantId: user.tenantId, warehouseId, code: 'RCV' } });
    if (!rcv) return [];
    return this.prisma.stockBalance.findMany({
      where: { tenantId: user.tenantId, cellId: rcv.id, stockType: STOCK.GOOD, qty: { gt: 0 } },
      include: { product: true },
    });
  }

  @Post('putaway')
  putaway(
    @CurrentUser() user: Authed,
    @Body() body: { warehouseId: string; productId: string; qty: number; toCellId?: string; toCellCode?: string },
  ) {
    return this.wave.putaway(user, body);
  }

  @Get('waves')
  waves(@CurrentUser() user: Authed) {
    return this.prisma.pickWave.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Post('waves')
  createWave(@CurrentUser() user: Authed, @Body() body: { warehouseId: string; orderIds?: string[] }) {
    return this.wave.createWave(user, body);
  }

  @Get('waves/:id')
  async one(@CurrentUser() user: Authed, @Param('id') id: string) {
    const w = await this.wave.getWave(user, id);
    return { ...w, lines: JSON.parse(w.linesJson), orders: JSON.parse(w.orderIds) };
  }

  @Post('waves/:id/pick')
  pick(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { barcode: string; qty?: number }) {
    return this.wave.pickWaveLine(user, id, body.barcode, body.qty || 1);
  }

  @Post('waves/:id/check')
  check(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { barcode: string; qty?: number }) {
    return this.wave.checkWaveLine(user, id, body.barcode, body.qty || 1);
  }

  @Get('waves/:id/pick-list')
  pickList(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.wave.pickListPdf(user, id);
  }

  @Post('consumables/use')
  useBag(@CurrentUser() user: Authed, @Body() body: { sku: string; qty: number; requestId?: string }) {
    return this.wave.consume(user, body);
  }

  @Post('labels/zpl')
  zpl(@Body() body: { sku: string; barcode: string; name: string }) {
    return this.wave.zpl(body.sku, body.barcode, body.name);
  }
}
