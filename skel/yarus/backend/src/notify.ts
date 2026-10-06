import { PrismaService } from './prisma.service';

export async function notify(
  prisma: PrismaService,
  opts: {
    tenantId: string;
    event: string;
    title: string;
    body: string;
    userId?: string;
    clientId?: string;
    channels?: string[];
  },
) {
  const channels = opts.channels || ['ui', 'telegram'];
  for (const channel of channels) {
    await prisma.notification.create({
      data: {
        tenantId: opts.tenantId,
        channel,
        event: opts.event,
        title: opts.title,
        body: opts.body,
        userId: opts.userId,
        clientId: opts.clientId,
      },
    });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !channels.includes('telegram')) return;
  const chats: string[] = [];
  if (opts.userId) {
    const u = await prisma.user.findUnique({ where: { id: opts.userId } });
    if (u?.telegramChatId) chats.push(u.telegramChatId);
  }
  if (opts.clientId) {
    const c = await prisma.client.findUnique({ where: { id: opts.clientId } });
    if (c?.telegramChatId) chats.push(c.telegramChatId);
  }
  for (const chat of chats) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: `${opts.title}\n${opts.body}` }),
      });
    } catch {
      /* log only */
    }
  }
}
