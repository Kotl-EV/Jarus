import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { YarusService } from './yarus.service';
import { PrismaService } from './prisma.service';
import { Authed, CurrentUser, Perm, Public } from './auth';
import { isClient } from './permissions';
import { PROCESS_PRESETS } from './process-presets';
import * as bcrypt from 'bcryptjs';
import { encryptSecret } from './crypto-util';

@ApiTags('yarus')
@ApiBearerAuth()
@Controller()
export class YarusController {
  constructor(
    @Inject(YarusService) private yarus: YarusService,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true, name: 'Ярус WMS', ts: new Date().toISOString() };
  }

  @Public()
  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.yarus.login(body.email, body.password);
  }

  @Public()
  @Post('auth/totp')
  totp(@Body() body: { userId: string; code: string }) {
    return this.yarus.verifyTotp(body.userId, body.code);
  }

  @Post('auth/totp/setup')
  setupTotp(@CurrentUser() user: Authed) {
    return this.yarus.setupTotp(user);
  }

  @Post('auth/totp/confirm')
  confirmTotp(@CurrentUser() user: Authed, @Body() body: { code: string }) {
    return this.yarus.confirmTotp(user, body.code);
  }

  @Get('auth/me')
  me(@CurrentUser() user: Authed) {
    return user;
  }

  @Public()
  @Post('auth/register')
  async register(
    @Body()
    body: {
      orgName: string;
      mode: string;
      currency: string;
      country: string;
      legalName: string;
      inn?: string;
      warehouseName: string;
      ownerEmail: string;
      ownerName: string;
      password: string;
    },
  ) {
    const r = await this.yarus.bootstrapTenant(body);
    return this.yarus.login(body.ownerEmail, body.password).then((l) => ({ ...l, ...r }));
  }

  @Get('dashboard')
  dashboard(@CurrentUser() user: Authed) {
    return this.yarus.dashboard(user);
  }

  @Get('org')
  async org(@CurrentUser() user: Authed) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId } });
    const legal = await this.prisma.legalEntity.findMany({ where: { tenantId: user.tenantId } });
    return { tenant, legal };
  }

  @Patch('org')
  async patchOrg(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    if (!user.permissions.domain && body.domain) throw new Error('Нет права на домен');
    const tenant = await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: {
        name: body.name ? String(body.name) : undefined,
        currency: body.currency ? String(body.currency) : undefined,
        locale: body.locale ? String(body.locale) : undefined,
        domain: body.domain ? String(body.domain) : undefined,
        logoUrl: body.logoUrl ? String(body.logoUrl) : undefined,
        brandColor: body.brandColor ? String(body.brandColor) : undefined,
        hidePlatform: typeof body.hidePlatform === 'boolean' ? body.hidePlatform : undefined,
        emailFromName: body.emailFromName ? String(body.emailFromName) : undefined,
        mode: body.mode ? String(body.mode) : undefined,
        saasPlan: body.saasPlan ? String(body.saasPlan) : undefined,
      },
    });
    await this.yarus.audit(user, 'update', 'Tenant', tenant.id, body);
    return tenant;
  }

  @Post('legal-entities')
  async createLe(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    return this.prisma.legalEntity.create({
      data: {
        tenantId: user.tenantId,
        name: String(body.name),
        inn: body.inn ? String(body.inn) : undefined,
        country: String(body.country || 'RU'),
        currency: String(body.currency || user.currency),
        address: body.address ? String(body.address) : undefined,
        isPartner: !!body.isPartner,
        stampUrl: body.stampUrl ? String(body.stampUrl) : undefined,
        signUrl: body.signUrl ? String(body.signUrl) : undefined,
        facsimileUrl: body.facsimileUrl ? String(body.facsimileUrl) : undefined,
      },
    });
  }

  @Get('warehouses')
  warehouses(@CurrentUser() user: Authed) {
    return this.prisma.warehouse.findMany({ where: { tenantId: user.tenantId }, include: { zones: true } });
  }

  @Post('warehouses')
  @Perm('topology')
  async createWh(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    const wh = await this.prisma.warehouse.create({
      data: {
        tenantId: user.tenantId,
        name: String(body.name),
        code: String(body.code),
        legalEntityId: body.legalEntityId ? String(body.legalEntityId) : undefined,
        address: body.address ? String(body.address) : undefined,
      },
    });
    await this.yarus.ensureSpecialCells(user.tenantId, wh.id);
    return wh;
  }

  @Post('warehouses/:id/grid')
  @Perm('topology')
  grid(
    @CurrentUser() user: Authed,
    @Param('id') id: string,
    @Body() body: { aisles: number; racks: number; shelves: number; cells: number },
  ) {
    return this.yarus.generateGrid(user.tenantId, id, body);
  }

  @Get('cells')
  async cells(@CurrentUser() user: Authed, @Query('warehouseId') warehouseId?: string) {
    const rows = await this.prisma.cell.findMany({
      where: { tenantId: user.tenantId, warehouseId },
      include: { balances: { include: { product: true } } },
      orderBy: { code: 'asc' },
    });
    if (!user.seeCells && isClient(user.role)) {
      return rows.map((c) => ({
        id: c.id,
        type: c.type,
        qty: c.balances.reduce((s, b) => s + b.qty, 0),
      }));
    }
    return rows;
  }

  @Patch('cells/:id')
  @Perm('topology')
  patchCell(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.prisma.cell.update({
      where: { id },
      data: {
        blocked: typeof body.blocked === 'boolean' ? body.blocked : undefined,
        mixClients: typeof body.mixClients === 'boolean' ? body.mixClients : undefined,
        mixLots: typeof body.mixLots === 'boolean' ? body.mixLots : undefined,
        volumeCm3: body.volumeCm3 != null ? Number(body.volumeCm3) : undefined,
      },
    });
  }

  @Patch('legal-entities/:id')
  patchLe(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.prisma.legalEntity.update({
      where: { id },
      data: {
        name: body.name ? String(body.name) : undefined,
        inn: body.inn ? String(body.inn) : undefined,
        bankName: body.bankName ? String(body.bankName) : undefined,
        bik: body.bik ? String(body.bik) : undefined,
        account: body.account ? String(body.account) : undefined,
        corrAccount: body.corrAccount ? String(body.corrAccount) : undefined,
        address: body.address ? String(body.address) : undefined,
        stampUrl: body.stampUrl ? String(body.stampUrl) : undefined,
        facsimileUrl: body.facsimileUrl ? String(body.facsimileUrl) : undefined,
      },
    });
  }

  @Get('clients')
  clients(@CurrentUser() user: Authed) {
    if (isClient(user.role)) return this.prisma.client.findMany({ where: { id: user.clientId || '' } });
    return this.prisma.client.findMany({ where: { tenantId: user.tenantId } });
  }

  @Post('clients')
  createClient(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    return this.yarus.createClient(user, body);
  }

  @Get('products')
  products(
    @CurrentUser() user: Authed,
    @Query('q') q?: string,
    @Query('clientId') clientId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const lim = Math.min(500, Math.max(1, Number(take || 100)));
    return this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        archived: false,
        ...(isClient(user.role) ? { clientId: user.clientId || undefined } : clientId ? { clientId } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { sku: { contains: q } },
                { barcodes: { some: { code: { contains: q } } } },
              ],
            }
          : {}),
      },
      include: { barcodes: true, bundleItems: { include: { component: true } }, client: true },
      take: lim,
      skip: Number(skip || 0),
    });
  }

  @Post('products')
  createProduct(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    return this.yarus.createProduct(user, body);
  }

  @Patch('products/:id')
  async patchProduct(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.prisma.product.update({
      where: { id },
      data: {
        name: body.name ? String(body.name) : undefined,
        archived: typeof body.archived === 'boolean' ? body.archived : undefined,
        requiresCis: typeof body.requiresCis === 'boolean' ? body.requiresCis : undefined,
        packingReq: body.packingReq ? String(body.packingReq) : undefined,
        widthMm: body.widthMm != null ? Number(body.widthMm) : undefined,
        heightMm: body.heightMm != null ? Number(body.heightMm) : undefined,
        lengthMm: body.lengthMm != null ? Number(body.lengthMm) : undefined,
        weightG: body.weightG != null ? Number(body.weightG) : undefined,
      },
    });
  }

  @Post('products/:id/barcode')
  barcode(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body?: { code?: string; kind?: string }) {
    const code = body?.code || this.yarus.generateBarcode();
    return this.yarus.addBarcode(user, id, code, body?.kind || 'ean13');
  }

  @Post('products/:id/bundle')
  async bundle(
    @CurrentUser() user: Authed,
    @Param('id') id: string,
    @Body() body: { items: { productId: string; qty: number }[] },
  ) {
    if (isClient(user.role) && !user.permissions.createBundles) throw new Error('Нельзя создавать комплекты');
    await this.prisma.bundleItem.deleteMany({ where: { bundleId: id, tenantId: user.tenantId } });
    for (const it of body.items) {
      await this.prisma.bundleItem.create({
        data: { tenantId: user.tenantId, bundleId: id, componentId: it.productId, qty: it.qty },
      });
    }
    return this.prisma.product.findFirst({ where: { id }, include: { bundleItems: true } });
  }

  @Get('stock')
  stock(
    @CurrentUser() user: Authed,
    @Query('clientId') clientId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const lim = Math.min(1000, Math.max(1, Number(take || 200)));
    return this.prisma.stockBalance.findMany({
      where: {
        tenantId: user.tenantId,
        qty: { not: 0 },
        ...(isClient(user.role) ? { clientId: user.clientId || undefined } : clientId ? { clientId } : {}),
        ...(warehouseId ? { warehouseId } : {}),
      },
      include: { product: true, cell: true, client: true },
      take: lim,
      skip: Number(skip || 0),
    });
  }

  @Get('stock/moves')
  moves(@CurrentUser() user: Authed, @Query('productId') productId?: string) {
    return this.prisma.stockMove.findMany({
      where: { tenantId: user.tenantId, ...(productId ? { productId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('stock/move')
  @Perm('stock')
  async move(@CurrentUser() user: Authed, @Body() body: {
    type: string;
    productId: string;
    clientId: string;
    qty: number;
    warehouseId: string;
    from?: { cellId: string; stockType: string; lotId?: string };
    to?: { cellId: string; stockType: string; lotId?: string };
  }) {
    const { applyMove, runStockTx } = await import('./stock.engine');
    await runStockTx(this.prisma, (tx) =>
      applyMove(tx, {
        ...body,
        tenantId: user.tenantId,
        userId: user.id,
        allowNegative: user.permissions.stockNegative,
      }),
    );
    return { ok: true };
  }

  @Post('stock/nominal-transfer')
  transferNominal(@CurrentUser() user: Authed, @Body() body: {
    productId: string;
    qty: number;
    fromClientId: string;
    toClientId: string;
    warehouseId: string;
  }) {
    return this.yarus.transferNominal(user, body);
  }

  @Get('request-types')
  requestTypes(@CurrentUser() user: Authed) {
    return this.prisma.requestType.findMany({ where: { tenantId: user.tenantId } });
  }

  @Post('request-types')
  async saveType(@CurrentUser() user: Authed, @Body() body: { code: string; name: string; stages: unknown[] }) {
    const last = await this.prisma.requestType.findFirst({
      where: { tenantId: user.tenantId, code: body.code },
      orderBy: { version: 'desc' },
    });
    return this.prisma.requestType.create({
      data: {
        tenantId: user.tenantId,
        code: body.code,
        name: body.name,
        builtIn: false,
        version: (last?.version || 0) + 1,
        stagesJson: JSON.stringify(body.stages),
      },
    });
  }

  @Get('process-presets')
  presets() {
    return PROCESS_PRESETS;
  }

  @Get('requests')
  requests(@CurrentUser() user: Authed, @Query('status') status?: string, @Query('type') type?: string) {
    return this.prisma.request.findMany({
      where: {
        tenantId: user.tenantId,
        ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}),
        ...(status ? { status } : {}),
      },
      include: { lines: true, stages: true, type: true, client: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('requests')
  createRequest(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    if (!user.permissions.requestCreate && !isClient(user.role)) throw new Error('Нет права создания заявок');
    return this.yarus.createRequest(user, body);
  }

  @Get('requests/:id')
  getRequest(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.getRequest(user, id);
  }

  @Post('requests/:id/start')
  start(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.startRequest(user, id);
  }

  @Post('requests/:id/approve')
  approve(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.decideRequest(user, id, true);
  }

  @Post('requests/:id/reject')
  reject(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.yarus.decideRequest(user, id, false, body.reason);
  }

  @Post('requests/:id/advance')
  advance(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { photo?: string }) {
    return this.yarus.advanceRequest(user, id, body.photo);
  }

  @Post('requests/:id/expenses')
  async expenses(
    @CurrentUser() user: Authed,
    @Param('id') id: string,
    @Body() body: { kind: string; amountKop: number; comment?: string },
  ) {
    return this.prisma.requestExpense.create({
      data: { tenantId: user.tenantId, requestId: id, ...body },
    });
  }

  @Post('requests/:id/fbo-shipment')
  fbo(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.createFboShipment(user, id);
  }

  @Post('requests/:id/inventory-approve')
  invApprove(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.inventoryApprove(user, id);
  }

  @Post('tsd/accept')
  accept(@CurrentUser() user: Authed, @Body() body: Parameters<YarusService['acceptScan']>[1]) {
    return this.yarus.acceptScan(user, body);
  }

  @Post('tsd/pick')
  pick(@CurrentUser() user: Authed, @Body() body: Parameters<YarusService['pickScan']>[1]) {
    return this.yarus.pickScan(user, body);
  }

  @Post('tsd/ship')
  ship(@CurrentUser() user: Authed, @Body() body: Parameters<YarusService['ship']>[1]) {
    return this.yarus.ship(user, body);
  }

  @Post('tsd/flush')
  async flush(@CurrentUser() user: Authed, @Body() body: { events: { kind: string; payload: Record<string, unknown> }[] }) {
    const results = [];
    for (const e of body.events) {
      try {
        if (e.kind === 'accept') results.push(await this.yarus.acceptScan(user, e.payload as never));
        else if (e.kind === 'pick') results.push(await this.yarus.pickScan(user, e.payload as never));
        else results.push({ skipped: e.kind });
      } catch (err) {
        results.push({ error: (err as Error).message });
      }
    }
    return { results };
  }

  @Get('cis')
  cis(
    @CurrentUser() user: Authed,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const lim = Math.min(500, Math.max(1, Number(take || 100)));
    return this.prisma.cisCode.findMany({
      where: {
        tenantId: user.tenantId,
        ...(status ? { status } : {}),
        ...(q ? { code: { contains: q } } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}),
      },
      include: { product: true },
      take: lim,
      skip: Number(skip || 0),
      orderBy: { uploadedAt: 'desc' },
    });
  }

  @Post('cis/import')
  importCis(@CurrentUser() user: Authed, @Body() body: { codes: string[]; productId?: string }) {
    return this.yarus.importCis(user, body.codes, body.productId);
  }

  @Post('cis/print')
  printCis(@CurrentUser() user: Authed, @Body() body: { ids: string[]; reprint?: boolean }) {
    return this.yarus.printCis(user, body.ids, body.reprint);
  }

  @Post('cis/:id/return-pool')
  async returnPool(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.prisma.cisCode.update({
      where: { id },
      data: { status: 'returned_to_pool', productId: null },
    });
  }

  @Get('fbs/orders')
  fbsOrders(@CurrentUser() user: Authed, @Query('warehouseId') warehouseId?: string) {
    return this.prisma.marketplaceOrder.findMany({
      where: { tenantId: user.tenantId, ...(warehouseId ? { warehouseId } : {}) },
      include: { account: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('fbs/orders/:id/cancel')
  cancel(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.cancelFbs(user, id);
  }

  @Public()
  @Post('webhooks/fbs/:tenantSlug')
  async webhook(
    @Param('tenantSlug') slug: string,
    @Headers('idempotency-key') idem: string,
    @Body() body: Record<string, unknown>,
    @Query('source') source?: string,
  ) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) return { error: 'unknown tenant' };
    const key = idem || String(body.posting_number || body.order_id || Date.now());
    return this.yarus.fbsWebhook(tenant.id, key, body, source || 'ozon');
  }

  @Get('mp-accounts')
  mp(@CurrentUser() user: Authed) {
    return this.prisma.marketplaceAccount.findMany({
      where: { tenantId: user.tenantId, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
    }).then((rows) => rows.map((r) => ({ ...r, apiKeyEnc: r.apiKeyEnc ? '********' : '' })));
  }

  @Post('mp-accounts')
  async createMp(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    return this.prisma.marketplaceAccount.create({
      data: {
        tenantId: user.tenantId,
        clientId: isClient(user.role) ? user.clientId! : String(body.clientId),
        marketplace: String(body.marketplace || 'ozon'),
        name: String(body.name || 'Мой Ozon'),
        apiKeyEnc: body.apiKey ? encryptSecret(String(body.apiKey)) : '',
        clientIdExt: body.clientIdExt ? String(body.clientIdExt) : undefined,
        warehouseExt: body.warehouseExt ? String(body.warehouseExt) : undefined,
      },
    });
  }

  @Patch('mp-accounts/:id')
  async patchMp(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const acc = await this.prisma.marketplaceAccount.findFirst({
      where: { id, tenantId: user.tenantId, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
    });
    if (!acc) return { error: 'not found' };
    return this.prisma.marketplaceAccount.update({
      where: { id },
      data: {
        name: body.name ? String(body.name) : undefined,
        apiKeyEnc: body.apiKey ? encryptSecret(String(body.apiKey)) : undefined,
        clientIdExt: body.clientIdExt != null ? String(body.clientIdExt) : undefined,
        warehouseExt: body.warehouseExt != null ? String(body.warehouseExt) : undefined,
      },
    });
  }

  @Post('mp-accounts/:id/push-stocks')
  push(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.pushStocks(user, id);
  }

  @Post('mp-accounts/:id/test')
  testMp(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.yarus.testMpAccount(user, id);
  }

  @Get('services')
  services(@CurrentUser() user: Authed) {
    return this.prisma.service.findMany({ where: { tenantId: user.tenantId } });
  }

  @Post('services/facts')
  fact(@CurrentUser() user: Authed, @Body() body: { requestId?: string; clientId: string; serviceCode: string; qty: number; stageKey?: string }) {
    return this.prisma.service.findFirst({ where: { tenantId: user.tenantId, code: body.serviceCode } }).then((s) => {
      const price = s?.priceKop || 0;
      return this.prisma.serviceFact.create({
        data: {
          tenantId: user.tenantId,
          requestId: body.requestId,
          clientId: body.clientId,
          serviceCode: body.serviceCode,
          qty: body.qty,
          priceKop: price,
          amountKop: Math.round(price * body.qty),
          stageKey: body.stageKey,
        },
      });
    });
  }

  @Post('quote')
  async quote(@CurrentUser() user: Authed, @Body() body: { items: { serviceCode: string; qty: number }[] }) {
    const services = await this.prisma.service.findMany({ where: { tenantId: user.tenantId } });
    const map = new Map(services.map((s) => [s.code, s]));
    const lines = body.items.map((i) => {
      const s = map.get(i.serviceCode);
      const price = s?.priceKop || 0;
      return { ...i, name: s?.name, priceKop: price, amountKop: Math.round(price * i.qty), costKop: Math.round((s?.costKop || 0) * i.qty) };
    });
    return {
      lines,
      totalKop: lines.reduce((s, l) => s + l.amountKop, 0),
      costKop: lines.reduce((s, l) => s + l.costKop, 0),
    };
  }

  @Post('storage/snapshot')
  snapshot(@CurrentUser() user: Authed) {
    return this.yarus.snapshotStorage(user.tenantId);
  }

  @Get('storage/daily')
  storageDaily(@CurrentUser() user: Authed, @Query('clientId') clientId?: string) {
    return this.prisma.storageDaily.findMany({
      where: { tenantId: user.tenantId, ...(clientId ? { clientId } : {}) },
      orderBy: { date: 'desc' },
      take: 90,
    });
  }

  @Get('invoices')
  invoices(@CurrentUser() user: Authed) {
    return this.prisma.invoice.findMany({
      where: { tenantId: user.tenantId, ...(isClient(user.role) ? { clientId: user.clientId || undefined } : {}) },
      include: { client: true, payments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('invoices')
  @Perm('invoices')
  invoice(@CurrentUser() user: Authed, @Body() body: { clientId: string; kind: string; periodFrom?: string; periodTo?: string; requestId?: string }) {
    return this.yarus.buildInvoice(user, body);
  }

  @Post('invoices/:id/pay')
  async pay(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { amountKop: number; method?: string }) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!inv) return { error: 'not found' };
    await this.prisma.payment.create({
      data: { tenantId: user.tenantId, invoiceId: id, clientId: inv.clientId, amountKop: body.amountKop, method: body.method || 'manual' },
    });
    const paid = await this.prisma.payment.aggregate({ where: { invoiceId: id }, _sum: { amountKop: true } });
    const status = (paid._sum.amountKop || 0) >= inv.amountKop ? 'paid' : 'partial';
    return this.prisma.invoice.update({ where: { id }, data: { status } });
  }

  @Post('invoices/:id/storno')
  @Perm('invoiceStorno')
  storno(@Param('id') id: string) {
    return this.prisma.invoice.update({ where: { id }, data: { status: 'storno' } });
  }

  @Get('tasks')
  tasks(@CurrentUser() user: Authed, @Query('mine') mine?: string) {
    const onlyMine = mine === '1' || (!user.permissions.othersTasks && user.role === 'Warehouse');
    return this.prisma.task.findMany({
      where: { tenantId: user.tenantId, ...(onlyMine ? { userId: user.id } : {}) },
      include: { request: true, user: true },
      orderBy: { dueAt: 'asc' },
    });
  }

  @Get('employees')
  employees(@CurrentUser() user: Authed) {
    return this.prisma.user.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, email: true, fullName: true, role: true, active: true, birthday: true, departmentId: true },
    });
  }

  @Post('employees')
  @Perm('users')
  async createEmp(@CurrentUser() user: Authed, @Body() body: Record<string, unknown>) {
    return this.prisma.user.create({
      data: {
        tenantId: user.tenantId,
        email: String(body.email).toLowerCase(),
        passwordHash: await bcrypt.hash(String(body.password || 'Demo123!'), 10),
        fullName: String(body.fullName),
        role: String(body.role),
        departmentId: body.departmentId ? String(body.departmentId) : undefined,
        birthday: body.birthday ? new Date(String(body.birthday)) : undefined,
        telegramChatId: body.telegramChatId ? String(body.telegramChatId) : undefined,
      },
    });
  }

  @Get('piecework')
  piecework(@CurrentUser() user: Authed) {
    return this.prisma.piecework.findMany({
      where: { tenantId: user.tenantId, ...(user.role === 'Warehouse' ? { userId: user.id } : {}) },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Get('notifications')
  notes(@CurrentUser() user: Authed) {
    return this.prisma.notification.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { sentAt: 'desc' },
      take: 100,
    });
  }

  @Get('audit')
  @Perm('audit')
  audit(@CurrentUser() user: Authed) {
    return this.prisma.auditLog.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: true },
    });
  }

  @Get('reports/:kind')
  reports(@CurrentUser() user: Authed, @Param('kind') kind: string) {
    return this.yarus.reports(user, kind);
  }

  @Post('api-keys')
  apiKey(@CurrentUser() user: Authed, @Body() body: { name: string; scopes?: string[] }) {
    return this.yarus.createApiKey(user, body.name, body.scopes || ['read']);
  }

  @Get('api-keys')
  keys(@CurrentUser() user: Authed) {
    return this.prisma.apiKey.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
    });
  }

  @Get('labels')
  labels(@CurrentUser() user: Authed) {
    return this.prisma.labelTemplate.findMany({ where: { tenantId: user.tenantId } });
  }

  @Post('labels')
  saveLabel(@CurrentUser() user: Authed, @Body() body: { name: string; widthMm: number; heightMm: number; layoutJson: string; kind?: string }) {
    return this.prisma.labelTemplate.create({ data: { tenantId: user.tenantId, ...body } });
  }

  @Get('print-jobs')
  jobs(@CurrentUser() user: Authed) {
    return this.prisma.printJob.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  @Get('consumables')
  consumables(@CurrentUser() user: Authed) {
    return this.prisma.consumable.findMany({ where: { tenantId: user.tenantId } });
  }

  @Get('birthdays')
  async birthdays(@CurrentUser() user: Authed) {
    const users = await this.prisma.user.findMany({ where: { tenantId: user.tenantId, birthday: { not: null } } });
    const today = new Date();
    return users.filter((u) => u.birthday && u.birthday.getMonth() === today.getMonth() && u.birthday.getDate() === today.getDate());
  }

  @Post('demo/fbs-order')
  async demoOrder(@CurrentUser() user: Authed, @Body() body: { sku?: string; qty?: number }) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId } });
    const product = body.sku
      ? await this.prisma.product.findFirst({ where: { tenantId: user.tenantId, sku: body.sku } })
      : await this.prisma.product.findFirst({ where: { tenantId: user.tenantId, archived: false } });
    return this.yarus.fbsWebhook(
      user.tenantId,
      'demo-' + Date.now(),
      {
        posting_number: 'DEMO-' + Date.now(),
        products: [{ offer_id: product?.sku, quantity: body.qty || 1 }],
      },
      'ozon',
    );
  }
}
