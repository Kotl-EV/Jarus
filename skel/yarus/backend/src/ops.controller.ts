import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser } from './auth';
import { OpsService } from './ops.service';
import { PrismaService } from './prisma.service';

@ApiTags('ops')
@ApiBearerAuth()
@Controller()
export class OpsController {
  constructor(
    @Inject(OpsService) private ops: OpsService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  @Get('gis-mt/settings')
  gisGet(@CurrentUser() user: Authed) {
    return this.ops.gisSettings(user);
  }

  @Post('gis-mt/settings')
  gisSet(@CurrentUser() user: Authed, @Body() body: { token?: string; inn?: string }) {
    return this.ops.gisSettings(user, body);
  }

  @Post('gis-mt/info')
  gisInfo(@CurrentUser() user: Authed, @Body() body: { codes: string[] }) {
    return this.ops.gisCisInfo(user, body.codes || []);
  }

  @Post('gis-mt/document')
  gisDoc(
    @CurrentUser() user: Authed,
    @Body() body: { action: 'introduce' | 'ship' | 'return'; ids: string[] },
  ) {
    return this.ops.gisDocument(user, body.action, body.ids || []);
  }

  @Get('warehouse/map')
  map(@CurrentUser() user: Authed, @Query('warehouseId') warehouseId: string) {
    return this.ops.warehouseMap(user, warehouseId);
  }

  @Get('shifts')
  shifts(@CurrentUser() user: Authed) {
    return this.prisma.shift.findMany({
      where: { tenantId: user.tenantId },
      include: { user: true },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
  }

  @Get('shifts/qr')
  qr(@CurrentUser() user: Authed) {
    return this.ops.shiftQr(user);
  }

  @Post('shifts/open')
  open(@CurrentUser() user: Authed) {
    return this.ops.openShift(user, 'manual');
  }

  @Post('shifts/close')
  close(@CurrentUser() user: Authed) {
    return this.ops.closeShift(user);
  }

  @Post('shifts/scan')
  scan(@CurrentUser() user: Authed, @Body() body: { payload: string }) {
    return this.ops.scanShift(user, body.payload);
  }

  @Post('fbs/orders/:id/tracking')
  tracking(
    @CurrentUser() user: Authed,
    @Param('id') id: string,
    @Body() body: { tracking?: string; pvz?: string; status?: string },
  ) {
    return this.ops.setTracking(user, id, body);
  }

  @Post('files')
  file(@CurrentUser() user: Authed, @Body() body: { requestId?: string; clientId?: string; kind: string; name: string; base64: string }) {
    return this.ops.attachFile(user, body);
  }

  @Get('files')
  files(@CurrentUser() user: Authed, @Query('requestId') requestId?: string) {
    return this.prisma.documentFile.findMany({
      where: { tenantId: user.tenantId, ...(requestId ? { requestId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post('edo/send')
  edo(@CurrentUser() user: Authed, @Body() body: { invoiceId: string; provider?: 'diadoc' | 'sbis' }) {
    return this.ops.edoSend(user, body.invoiceId, body.provider || 'diadoc');
  }

  @Get('requests/:id/waybill')
  waybill(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.ops.waybillPdf(user, id);
  }
}
