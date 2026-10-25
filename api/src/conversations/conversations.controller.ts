import {
  Body,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsString, IsUUID, Length } from 'class-validator';
import type { Response } from 'express';
import { AppHeaderGuard } from '../common/app-header.guard.js';
import { toRiyadhIso } from '../common/time.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService, eventText } from './conversations.service.js';

class CreateConversationDto {
  @IsUUID()
  patientId!: string;
}

class SendMessageDto {
  @IsUUID()
  clientMessageId!: string;

  @IsString()
  @Length(1, 2000)
  text!: string;
}

type Block = { type: string; text?: string };
const texts = (content: unknown, skipContext: boolean): string =>
  (Array.isArray(content) ? (content as Block[]) : [])
    .filter(
      (b) =>
        b.type === 'text' &&
        b.text &&
        !(skipContext && b.text.startsWith('<context>')),
    )
    .map((b) => b.text)
    .join('\n');

/** SSE frame with "\n" separators (parsed by web/src/lib/sse.ts). */
const sse = (res: Response, event: string, data: unknown) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

@Controller()
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('patients')
  patients() {
    return this.prisma.patient.findMany({
      select: { id: true, name: true, phone: true },
      orderBy: { phone: 'asc' },
    });
  }

  @Post('conversations')
  @UseGuards(AppHeaderGuard)
  async create(@Body() body: CreateConversationDto) {
    const created = await this.conversations.create(body.patientId);
    if (!created) throw new NotFoundException('No such patient.');
    return created;
  }

  /** What the chat shows: patient and agent text, clinic events, and proposal cards. */
  @Get('conversations/:conversationId')
  async get(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        messages: { orderBy: { createdAt: 'asc' } },
        actions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conversation) throw new NotFoundException('No such conversation.');
    const messages = conversation.messages
      .map((m) => ({
        id: m.id,
        at: toRiyadhIso(m.createdAt),
        role:
          m.role === 'event'
            ? 'event'
            : m.role === 'user'
              ? 'patient'
              : 'agent',
        text:
          m.role === 'event'
            ? eventText(m.content as never)
            : texts(m.content, m.role === 'user'),
      }))
      .filter((m) => m.text);
    const actions = conversation.actions.map((a) => ({
      id: a.id,
      status: a.status,
      payload: a.payload,
      expiresAt: toRiyadhIso(a.expiresAt),
      at: toRiyadhIso(a.createdAt),
    }));
    return {
      id: conversation.id,
      status: conversation.status,
      patient: conversation.patient,
      messages,
      actions,
    };
  }

  @Post('conversations/:conversationId/messages')
  @UseGuards(AppHeaderGuard)
  async send(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(); // the browser went away mid-turn
    });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.status(200).setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
    };
    try {
      const result = await this.conversations.send(
        conversationId,
        body.clientMessageId,
        body.text,
        (delta) => {
          start();
          sse(res, 'delta', { text: delta });
        },
        abort.signal,
        { onStart: start },
      );
      if (result.status === 'not_found')
        throw new NotFoundException('No such conversation.');
      if (result.status === 'busy')
        throw new HttpException(
          'Another message is still being answered.',
          409,
        );
      start();
      if (result.status === 'no_api_key')
        sse(res, 'error', {
          message: 'ANTHROPIC_API_KEY is not set on the server.',
        });
      else sse(res, 'done', result);
    } catch (error) {
      if (!started) throw error; // nothing streamed yet: a normal HTTP error
      sse(res, 'error', {
        message: 'The reply was interrupted. Please send your message again.',
        resend: true,
      });
    }
    res.end();
  }
}
