import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { requires2fa } from './permissions';

function esc(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class ExchangeService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(JwtService) private jwt: JwtService,
  ) {}

  async catalogXml(user: Authed) {
    const products = await this.prisma.product.findMany({
      where: { tenantId: user.tenantId, archived: false },
      include: { barcodes: true, client: true },
    });
    const date = new Date().toISOString();
    const items = products
      .map(
        (p) => `    <Товар>
      <Ид>${esc(p.id)}</Ид>
      <Артикул>${esc(p.sku)}</Артикул>
      <Наименование>${esc(p.name)}</Наименование>
      <БазоваяЕдиница Код="796" НаименованиеПолное="Штука">шт</БазоваяЕдиница>
      <Штрихкод>${esc(p.barcodes[0]?.code || '')}</Штрихкод>
      <Группы><Ид>${esc(p.clientId)}</Ид></Группы>
    </Товар>`,
      )
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05" ДатаФормирования="${date}">
  <Каталог СодержитТолькоИзменения="false">
    <Ид>${esc(user.tenantId)}</Ид>
    <Наименование>${esc(user.tenantName)}</Наименование>
    <Товары>
${items}
    </Товары>
  </Каталог>
</КоммерческаяИнформация>`;
    return {
      name: 'catalog-1c.xml',
      mime: 'application/xml',
      base64: Buffer.from(xml, 'utf8').toString('base64'),
    };
  }

  async stockXml(user: Authed) {
    const rows = await this.prisma.stockBalance.findMany({
      where: { tenantId: user.tenantId, qty: { not: 0 }, stockType: 'good' },
      include: { product: true, cell: true },
    });
    const byProduct = new Map<string, number>();
    for (const r of rows) byProduct.set(r.productId, (byProduct.get(r.productId) || 0) + r.qty);
    const date = new Date().toISOString();
    const offers = [...byProduct.entries()]
      .map(
        ([id, qty]) => `    <Предложение>
      <Ид>${esc(id)}</Ид>
      <Количество>${qty}</Количество>
    </Предложение>`,
      )
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05" ДатаФормирования="${date}">
  <ПакетПредложений>
    <Ид>${esc(user.tenantId)}-stock</Ид>
    <Наименование>Остатки ${esc(user.tenantName)}</Наименование>
    <Предложения>
${offers}
    </Предложения>
  </ПакетПредложений>
</КоммерческаяИнформация>`;
    return {
      name: 'stock-1c.xml',
      mime: 'application/xml',
      base64: Buffer.from(xml, 'utf8').toString('base64'),
    };
  }

  async loginPin(slug: string, pin: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { OR: [{ slug }, { name: slug }] },
    });
    if (!tenant || tenant.blocked) throw new BadRequestException('Организация не найдена');
    const users = await this.prisma.user.findMany({
      where: { tenantId: tenant.id, active: true, NOT: { pinHash: null } },
      include: { tenant: true },
    });
    for (const user of users) {
      if (!user.pinHash) continue;
      const ok = await bcrypt.compare(pin, user.pinHash);
      if (!ok) continue;
      const token = await this.jwt.signAsync(
        { sub: user.id, tfa: !(requires2fa(user.role) && user.totpEnabled) },
        { expiresIn: '12h' },
      );
      return { token, user: { id: user.id, fullName: user.fullName, role: user.role } };
    }
    throw new BadRequestException('Неверный PIN');
  }

  async setPin(user: Authed, userId: string, pin: string) {
    if (!/^\d{4,8}$/.test(pin)) throw new BadRequestException('PIN — 4–8 цифр');
    const hash = await bcrypt.hash(pin, 10);
    return this.prisma.user.update({ where: { id: userId }, data: { pinHash: hash } });
  }

  async enqueueZpl(user: Authed, zpl: string, copies = 1) {
    return this.prisma.printJob.create({
      data: { tenantId: user.tenantId, zpl, copies, status: 'queued' },
    });
  }

  async claimJob(user: Authed) {
    const job = await this.prisma.printJob.findFirst({
      where: { tenantId: user.tenantId, status: 'queued' },
      orderBy: { createdAt: 'asc' },
    });
    if (!job) return { empty: true };
    await this.prisma.printJob.update({ where: { id: job.id }, data: { status: 'printing' } });
    return job;
  }

  async finishJob(user: Authed, id: string, ok = true) {
    return this.prisma.printJob.update({
      where: { id },
      data: { status: ok ? 'done' : 'error' },
    });
  }

  async usage(user: Authed) {
    const t = user.tenantId;
    const [products, requests, fbs, cis, users] = await Promise.all([
      this.prisma.product.count({ where: { tenantId: t } }),
      this.prisma.request.count({ where: { tenantId: t } }),
      this.prisma.marketplaceOrder.count({ where: { tenantId: t } }),
      this.prisma.cisCode.count({ where: { tenantId: t } }),
      this.prisma.user.count({ where: { tenantId: t } }),
    ]);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: t } });
    return { plan: tenant?.saasPlan, products, requests, fbs, cis, users };
  }
}
