import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { Authed } from './auth';
import { YarusService } from './yarus.service';

function guard(user: Authed) {
  if (user.role !== 'PlatformAdmin') throw new ForbiddenException('Только владелец платформы');
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(JwtService) private jwt: JwtService,
    @Inject(YarusService) private yarus: YarusService,
  ) {}

  async overview(user: Authed) {
    guard(user);
    const tenants = await this.prisma.tenant.findMany({ where: { mode: { not: 'platform' } } });
    const [users, products, requests, fbs, invoices, cis] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.product.count(),
      this.prisma.request.count(),
      this.prisma.marketplaceOrder.count(),
      this.prisma.invoice.aggregate({ _sum: { amountKop: true }, _count: true }),
      this.prisma.cisCode.count(),
    ]);
    const byPlan: Record<string, number> = {};
    let blocked = 0;
    for (const t of tenants) {
      byPlan[t.saasPlan] = (byPlan[t.saasPlan] || 0) + 1;
      if (t.blocked) blocked++;
    }
    return {
      tenants: tenants.length,
      blocked,
      users,
      products,
      requests,
      fbs,
      invoices: invoices._count,
      turnoverKop: invoices._sum.amountKop || 0,
      cis,
      byPlan,
    };
  }

  async tenants(user: Authed) {
    guard(user);
    const list = await this.prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
    const out = [];
    for (const t of list) {
      const [users, products, requests, fbs] = await Promise.all([
        this.prisma.user.count({ where: { tenantId: t.id } }),
        this.prisma.product.count({ where: { tenantId: t.id } }),
        this.prisma.request.count({ where: { tenantId: t.id } }),
        this.prisma.marketplaceOrder.count({ where: { tenantId: t.id } }),
      ]);
      out.push({ ...t, stats: { users, products, requests, fbs } });
    }
    return out;
  }

  async createTenant(
    user: Authed,
    body: {
      orgName: string;
      ownerEmail: string;
      ownerName: string;
      password: string;
      mode?: string;
      plan?: string;
    },
  ) {
    guard(user);
    const r = await this.yarus.bootstrapTenant({
      orgName: body.orgName,
      mode: body.mode || 'fulfillment',
      currency: 'RUB',
      country: 'RU',
      legalName: body.orgName,
      warehouseName: 'Основной склад',
      ownerEmail: body.ownerEmail,
      ownerName: body.ownerName,
      password: body.password || 'Demo123!',
    });
    if (body.plan) {
      await this.prisma.tenant.update({ where: { id: r.tenant.id }, data: { saasPlan: body.plan } });
    }
    return r;
  }

  async patchTenant(user: Authed, id: string, body: { blocked?: boolean; saasPlan?: string; featureFlags?: Record<string, boolean> }) {
    guard(user);
    const t = await this.prisma.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Тенант');
    let flags = t.featureFlags;
    if (body.featureFlags) {
      try {
        flags = JSON.stringify({ ...JSON.parse(t.featureFlags || '{}'), ...body.featureFlags });
      } catch {
        flags = JSON.stringify(body.featureFlags);
      }
    }
    return this.prisma.tenant.update({
      where: { id },
      data: {
        blocked: typeof body.blocked === 'boolean' ? body.blocked : undefined,
        saasPlan: body.saasPlan,
        featureFlags: body.featureFlags ? flags : undefined,
      },
    });
  }

  async impersonate(user: Authed, tenantId: string) {
    guard(user);
    const owner = await this.prisma.user.findFirst({
      where: { tenantId, role: 'Owner', active: true },
    });
    if (!owner) throw new NotFoundException('У тенанта нет Owner');
    const token = await this.jwt.signAsync({ sub: owner.id, tfa: true, via: 'platform' }, { expiresIn: '4h' });
    return { token, email: owner.email, tenantId };
  }

  async queues(user: Authed) {
    guard(user);
    const [printJobs, webhooks] = await Promise.all([
      this.prisma.printJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.webhook.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const queued = printJobs.filter((j) => j.status === 'queued').length;
    return { queued, printJobs, webhooks };
  }

  async health(user: Authed) {
    guard(user);
    const db = await this.prisma.tenant.count();
    return { ok: true, dbTenants: db, ts: new Date().toISOString(), api: 'Ярус' };
  }
}
