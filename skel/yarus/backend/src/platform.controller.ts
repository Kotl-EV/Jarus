import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authed, CurrentUser } from './auth';
import { PlatformService } from './platform.service';

@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformController {
  constructor(@Inject(PlatformService) private plat: PlatformService) {}

  @Get('overview')
  overview(@CurrentUser() user: Authed) {
    return this.plat.overview(user);
  }

  @Get('tenants')
  tenants(@CurrentUser() user: Authed) {
    return this.plat.tenants(user);
  }

  @Post('tenants')
  create(
    @CurrentUser() user: Authed,
    @Body()
    body: {
      orgName: string;
      ownerEmail: string;
      ownerName: string;
      password: string;
      mode?: string;
      plan?: string;
    },
  ) {
    return this.plat.createTenant(user, body);
  }

  @Post('tenants/:id/block')
  block(@CurrentUser() user: Authed, @Param('id') id: string, @Body() body: { blocked: boolean }) {
    return this.plat.patchTenant(user, id, { blocked: body.blocked });
  }

  @Patch('tenants/:id')
  patch(
    @CurrentUser() user: Authed,
    @Param('id') id: string,
    @Body() body: { blocked?: boolean; saasPlan?: string; featureFlags?: Record<string, boolean> },
  ) {
    return this.plat.patchTenant(user, id, body);
  }

  @Post('tenants/:id/impersonate')
  impersonate(@CurrentUser() user: Authed, @Param('id') id: string) {
    return this.plat.impersonate(user, id);
  }

  @Get('queues')
  queues(@CurrentUser() user: Authed) {
    return this.plat.queues(user);
  }

  @Get('health')
  health(@CurrentUser() user: Authed) {
    return this.plat.health(user);
  }
}
