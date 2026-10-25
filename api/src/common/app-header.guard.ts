import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/** State-changing requests must carry X-Requested-By: a custom header forces a CORS preflight,
 * which only the web origin passes, so other sites can't post forms into the demo. */
@Injectable()
export class AppHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.header('x-requested-by') !== 'clinic-booking-agent') {
      throw new ForbiddenException('Missing X-Requested-By header.');
    }
    return true;
  }
}
