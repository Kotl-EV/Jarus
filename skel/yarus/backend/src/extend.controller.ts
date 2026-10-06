import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser } from './auth';
import { ExtendService } from './extend.service';
import { PrismaService } from './prisma.service';
import { isClient } from './permissions';

@ApiTags('extend')
@ApiBearerAuth()
@Controller()
export class ExtendController {
  constructor(
    @Inject(ExtendService) private ext: ExtendService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  @Post('import/products')
  importProducts(@CurrentUser() user: Authed, @Body() body: { clientId?: string; base64?: string; rows?: Record<string, string>[] }) {
    return this.ext.importProducts(user, body);
  }

  @Post('import/requests')
  importRequests(
    @CurrentUser() user: Authed,
    @Body() body: { typeCode: string; clientId?: string; warehouseId?: string; base64?: string; rows?: { sku: string; qty: number }[] },
  ) {
    return this.ext.importRequests(user, body);
  }

  @Get('export/:kind')
  exportExcel(@CurrentUser() user: Authed, @Param('kind') kind: 'products' | 'stock' | 'cis' | 'requests' | 'storage') {
    return this.ext.exportExcel(user, kind);
  }

  @Post('labels/pdf')
  labelPdf(@CurrentUser() user: Authed, @Body() body: { productId?: string; cisId?: string; copies?: number }) {
    return this.ext.labelPdf(user, body);
  }

  @Get('invoices/:id/pdf')
  invoicePdf(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.ext.invoicePdf(user, id);
  }

  @Get('invoices/:id/act')
  actPdf(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.ext.actPdf(user, id);
  }

  @Post('documents/quote-pdf')
  quote(@CurrentUser() user: Authed, @Body() body: { items: { serviceCode: string; qty: number }[]; clientId?: string }) {
    return this.ext.quotePdf(user, body);
  }

  @Get('requests/:id/packing-list')
  packing(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.ext.packingListPdf(user, id);
  }

  @Get('requests/:id/inventory-act')
  invAct(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.ext.inventoryActPdf(user, id);
  }

  @Get('containers')
  containers(@CurrentUser() user: Authed) {
    return this.prisma.container.findMany({
      where: { tenantId: user.tenantId, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
      include: { cell: true },
      orderBy: { barcode: 'asc' },
    });
  }

  @Post('containers')
  createBox(@CurrentUser() user: Authed, @Body() body: { kind: string; barcode?: string; cellId?: string; clientId?: string; capacity?: number }) {
    return this.ext.createContainer(user, body);
  }

  @Post('containers/:id/pack')
  pack(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { productId: string; qty: number; warehouseId: string; fromCellId?: string }) {
    return this.ext.packContainer(user, id, body);
  }

  @Post('containers/:id/move')
  moveBox(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { cellId: string; warehouseId: string }) {
    return this.ext.moveContainer(user, id, body);
  }

  @Post('containers/:id/unpack')
  unpack(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { warehouseId: string; cellId?: string }) {
    return this.ext.unpackContainer(user, id, body);
  }

  @Post('returns/decide')
  ret(@CurrentUser() user: Authed, @Body() body: {
    productId: string;
    qty: number;
    warehouseId: string;
    decision: 'good' | 'defect' | 'util';
    source?: string;
    orderId?: string;
    requestId?: string;
  }) {
    return this.ext.decideReturn(user, body);
  }

  @Post('inventory/start')
  invStart(@CurrentUser() user: Authed, @Body() body: { warehouseId: string; zoneId?: string }) {
    return this.ext.startInventory(user, body);
  }

  @Post('inventory/count')
  invCount(@CurrentUser() user: Authed, @Body() body: { requestId: string; barcode: string; qty: number; cellCode?: string }) {
    return this.ext.inventoryCount(user, body);
  }

  @Post('inventory/close')
  invClose(@CurrentUser() user: Authed, @Body() body: { requestId: string }) {
    return this.ext.closeInventory(user, body.requestId);
  }

  @Get('lots')
  lots(@CurrentUser() user: Authed, @Query('productId') productId?: string) {
    return this.prisma.lot.findMany({
      where: { tenantId: user.tenantId, ...(productId ? { productId } : {}) },
      include: { product: true },
      orderBy: { expiresAt: 'asc' },
    });
  }

  @Post('lots')
  createLot(@CurrentUser() user: Authed, @Body() body: { productId: string; number: string; expiresAt?: string; producedAt?: string; gtd?: string }) {
    return this.ext.createLot(user, body);
  }

  @Get('lots/expiring')
  expiring(@CurrentUser() user: Authed, @Query('days') days?: string) {
    return this.ext.expiring(user, Number(days || 30));
  }
}
