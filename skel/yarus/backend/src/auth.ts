import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { mergePermissions, PermKey, requires2fa } from './permissions';

export type Authed = {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  clientId: string | null;
  fullName: string;
  permissions: Record<PermKey, boolean>;
  tenantName: string;
  tenantSlug: string;
  tenantMode: string;
  brandColor: string;
  logoUrl: string | null;
  hidePlatform: boolean;
  currency: string;
  seeCells: boolean;
};

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user as Authed;
});

export const Public = () => SetMetadata('public', true);
export const Perm = (...keys: PermKey[]) => SetMetadata('perms', keys);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private jwt: JwtService,
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(Reflector) private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const url = String(req.originalUrl || req.url || '');
    if (url.startsWith('/api/docs') || url.startsWith('/docs')) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]);
    const header = (req.headers.authorization as string) || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'];
    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Нужна авторизация');
    }

    if (header.startsWith('Bearer ')) {
      let payload: { sub: string; tfa?: boolean };
      try {
        payload = await this.jwt.verifyAsync(token);
      } catch {
        if (isPublic) return true;
        throw new UnauthorizedException('Сессия истекла, войдите снова');
      }
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, include: { tenant: true, client: true } });
      if (!user || !user.active) {
        if (isPublic) return true;
        throw new UnauthorizedException('Сессия устарела, войдите снова');
      }
      if (user.tenant.blocked) throw new ForbiddenException('Тенант заблокирован');
      if (requires2fa(user.role) && user.totpEnabled && payload.tfa === false) {
        throw new UnauthorizedException('Требуется 2FA');
      }
      const perms = mergePermissions(user.role, user.permissionsJson);
      if (user.client) {
        perms.seeCells = user.client.seeCells;
        perms.createBundles = user.client.canCreateBundles;
        perms.clientEditRequests = user.client.canEditRequests;
      }
      const needed: PermKey[] = Reflect.getMetadata('perms', ctx.getHandler()) || [];
      for (const p of needed) {
        if (!perms[p]) throw new ForbiddenException('Недостаточно прав: ' + p);
      }
      req.user = {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
        clientId: user.clientId,
        fullName: user.fullName,
        permissions: perms,
        tenantName: user.tenant.name,
        tenantSlug: user.tenant.slug,
        tenantMode: user.tenant.mode,
        brandColor: user.tenant.brandColor,
        logoUrl: user.tenant.logoUrl,
        hidePlatform: user.tenant.hidePlatform,
        currency: user.tenant.currency,
        seeCells: perms.seeCells,
      } satisfies Authed;
      return true;
    }

    const prefix = String(token).slice(0, 8);
    const keys = await this.prisma.apiKey.findMany({ where: { prefix } });
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const key = keys.find((k) => k.keyHash === hash);
    if (!key) {
      if (isPublic) return true;
      throw new UnauthorizedException('Неверный API-ключ');
    }
    await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: key.tenantId } });
    if (!tenant || tenant.blocked) throw new ForbiddenException('Тенант заблокирован');
    req.user = {
      id: 'api:' + key.id,
      tenantId: key.tenantId,
      email: 'api@' + tenant.slug,
      role: 'API',
      clientId: null,
      fullName: key.name,
      permissions: mergePermissions('API', '{}'),
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      tenantMode: tenant.mode,
      brandColor: tenant.brandColor,
      logoUrl: tenant.logoUrl,
      hidePlatform: tenant.hidePlatform,
      currency: tenant.currency,
      seeCells: true,
    } satisfies Authed;
    return true;
  }
}
