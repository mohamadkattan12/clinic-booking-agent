import {
  ConflictException,
  Controller,
  GoneException,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AppHeaderGuard } from '../common/app-header.guard.js';
import { ActionsService, type ResolveResult } from './actions.service.js';

/** The only way an appointment changes: the patient presses Confirm (the model cannot call this). */
@Controller('conversations/:conversationId/actions/:actionId')
@UseGuards(AppHeaderGuard)
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Post('confirm')
  @HttpCode(200)
  async confirm(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return respond(await this.actions.confirm(conversationId, actionId));
  }

  @Post('decline')
  @HttpCode(200)
  async decline(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
  ) {
    return respond(await this.actions.decline(conversationId, actionId));
  }
}

function respond(result: ResolveResult) {
  switch (result.status) {
    case 'confirmed':
    case 'declined':
      return result;
    case 'failed':
      throw new ConflictException({
        status: 'failed',
        reason: result.outcome.ok ? null : result.outcome.reason,
      });
    case 'not_found':
      throw new NotFoundException('No such action in this conversation.');
    case 'gone':
      throw new GoneException({ status: 'gone', reason: result.reason });
  }
}
