import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractAllImages, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage, type MessageItem } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingAttachments {
  imageItems: MessageItem[];
  fileItems: MessageItem[];
  fromUserId: string;
  contextToken: string;
  timer?: ReturnType<typeof setTimeout>;
  hasNotified: boolean;
  lastAttachmentTime: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

// Extensions eligible for auto-push when detected in Claude's response
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from Claude's response text. */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  // Match absolute paths (macOS/Linux), tilde paths, and Windows paths with a file extension
  const regex = /(?:\/(?:Users|home|tmp|var|etc)\/[^\s`'"()\[\]{}|<>]+\.\w+|~\/[^\s`'"()\[\]{}|<>]+\.\w+|[A-Za-z]:[\\\/][^\s`'"()\[\]{}|<>]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const resolved = raw.startsWith('~')
      ? raw.replace(/^~/, homedir())
      : raw;
    paths.push(resolved);
  }
  return paths;
}

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Card-aware message splitter.
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// Store original query context for mid-processing redirects (shared across daemon lifecycle)
let lastQueryCtx: {
  userText: string;
  imageItems: MessageItem[];
  fileItems: MessageItem[];
  fromUserId: string;
  contextToken: string;
} | null = null;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'ClaudeCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  // -- Message queue for serial processing --
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      await handleMessage(msg, account!, session, sessionStore, sender, config, sharedCtx, activeControllers, messageQueue);
    }
    processingQueue = false;
  }

  // -- Message Aggregator: collects images/files until user sends text --

  const pendingAttachments: PendingAttachments = {
    imageItems: [],
    fileItems: [],
    fromUserId: '',
    contextToken: '',
    hasNotified: false,
    lastAttachmentTime: 0,
  };

  function clearPendingAttachments(): void {
    if (pendingAttachments.timer) {
      clearTimeout(pendingAttachments.timer);
      pendingAttachments.timer = undefined;
    }
    pendingAttachments.imageItems = [];
    pendingAttachments.fileItems = [];
    pendingAttachments.hasNotified = false;
    pendingAttachments.lastAttachmentTime = 0;
  }

  function aggregateAttachments(msg: WeixinMessage, imageItems: MessageItem[], fileItem: MessageItem | undefined): void {
    const fromUserId = msg.from_user_id!;
    const contextToken = msg.context_token ?? '';

    // If a notification was already sent, start a fresh collection round
    if (pendingAttachments.hasNotified) {
      pendingAttachments.hasNotified = false;
    }

    // Merge into pending
    pendingAttachments.imageItems.push(...imageItems);
    if (fileItem) pendingAttachments.fileItems.push(fileItem);
    pendingAttachments.fromUserId = fromUserId;
    pendingAttachments.contextToken = contextToken;
    pendingAttachments.lastAttachmentTime = Date.now();

    // Don't notify while Claude is processing — just collect silently
    if (session.state === 'processing') return;

    // Refresh notification timer
    if (pendingAttachments.timer) clearTimeout(pendingAttachments.timer);
    pendingAttachments.timer = setTimeout(() => {
      pendingAttachments.timer = undefined;
      if (pendingAttachments.imageItems.length === 0) return;

      pendingAttachments.hasNotified = true;
      // No notification — user will send instructions when ready
    }, 2000);
  }

  // -- Wire the monitor callbacks --

  /** Handle priority commands (/stop, /clear) immediately, bypassing the serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;

    const ctrl = activeControllers.get(account!.accountId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(account!.accountId); }

    // Also clear pending attachments for /clear
    if (text.startsWith('/clear')) clearPendingAttachments();

    session.state = 'idle';
    sessionStore.save(account!.accountId, session);

    if (text.startsWith('/stop')) {
      messageQueue.length = 0;
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    } else if (text.startsWith('/clear')) {
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '✅ 会话已清除，下次消息将开始新会话。').catch(() => {});
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;

      // Filter invalid messages (same guards as handleMessage)
      if (msg.message_type !== MessageType.USER) return;
      if (!msg.from_user_id || !msg.item_list) return;

      const userText = extractTextFromItems(msg.item_list);
      const imageItems = extractAllImages(msg.item_list);
      const fileItem = extractFirstFileItem(msg.item_list);

      // /clear while idle — clear pending without aborting (nothing running)
      if (userText.startsWith('/clear')) clearPendingAttachments();

      // Commands (/xxx) bypass aggregator even with attachments
      if (userText.startsWith('/')) {
        messageQueue.push(msg);
        drainQueue();
        return;
      }

      // Message with attachments → aggregate, don't push to queue
      if (imageItems.length > 0 || fileItem) {
        aggregateAttachments(msg, imageItems, fileItem);
        return;
      }

      // Plain text while pendingAttachments exist → flush merged task to Claude
      const hasPending = pendingAttachments.imageItems.length > 0 || pendingAttachments.fileItems.length > 0;
      if (hasPending) {
        if (pendingAttachments.timer) {
          clearTimeout(pendingAttachments.timer);
          pendingAttachments.timer = undefined;
        }

        // TTL: discard attachments older than 5 minutes to avoid stale images bleeding into unrelated queries
        if (pendingAttachments.lastAttachmentTime > 0 && Date.now() - pendingAttachments.lastAttachmentTime > 5 * 60 * 1000) {
          logger.info('Pending attachments expired, discarding', { ageSeconds: Math.round((Date.now() - pendingAttachments.lastAttachmentTime) / 1000) });
          clearPendingAttachments();
          messageQueue.push(msg);
          drainQueue();
          return;
        }

        pendingAttachments.hasNotified = false;

        await sendToClaude(
          userText,
          pendingAttachments.imageItems,
          pendingAttachments.fileItems,
          pendingAttachments.fromUserId,
          pendingAttachments.contextToken,
          account!, session, sessionStore, sender, config, activeControllers,
        );

        clearPendingAttachments();
        return;
      }

      // Plain text, no pending → normal queue path
      messageQueue.push(msg);
      drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    for (const [, ctrl] of activeControllers) ctrl.abort();
    activeControllers.clear();
    setTimeout(() => process.exit(0), 500); // give child processes time to die
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  messageQueue: WeixinMessage[],
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItems = extractAllImages(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  // Intercept non-command messages during processing for mid-stream redirect
  if (session.state === 'processing') {
    // /stop and /clear already handled upstream by handlePriorityCommand
    if (userText.startsWith('/')) return;

    logger.info('Redirect: interrupting current query with new instruction', {
      newText: userText.slice(0, 100),
    });

    const ctrl = activeControllers.get(account.accountId);
    if (ctrl) ctrl.abort();
    messageQueue.length = 0;

    if (lastQueryCtx) {
      const combinedUserText = `${lastQueryCtx.userText}\n\n---\n用户补充指令: ${userText}`;
      await sendToClaude(
        combinedUserText,
        lastQueryCtx.imageItems,
        lastQueryCtx.fileItems,
        lastQueryCtx.fromUserId,
        lastQueryCtx.contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
    } else {
      await sendToClaude(
        userText, imageItems, fileItem ? [fileItem] : [], fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
    }
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToClaude(
        result.claudePrompt, imageItems, fileItem ? [fileItem] : [], fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled) return;

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude --

  if (!userText && imageItems.length === 0 && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToClaude(
    userText, imageItems, fileItem ? [fileItem] : [], fromUserId, contextToken,
    account, session, sessionStore, sender, config, activeControllers,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToClaude(
  userText: string,
  imageItems: MessageItem[],
  fileItems: MessageItem[],
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Store context for potential mid-processing redirect
  lastQueryCtx = { userText, imageItems, fileItems, fromUserId, contextToken };

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Record user message in chat history
  const imageNote = imageItems.length > 1
    ? `(用户发送了${imageItems.length}张图片)`
    : imageItems.length === 1 ? '(图片)' : '';
  sessionStore.addChatMessage(session, 'user', userText || imageNote || '(无内容)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download images if present (parallel download for multiple photos)
    let images: QueryOptions['images'];
    if (imageItems.length > 0) {
      const results = await Promise.all(
        imageItems.map(async (imgItem) => {
          const base64DataUri = await downloadImage(imgItem);
          if (base64DataUri) {
            const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: matches[1],
                  data: matches[2],
                },
              };
            }
          }
          return null;
        })
      );
      const downloaded = results.filter((x): x is NonNullable<typeof x> => x !== null);
      if (downloaded.length > 0) images = downloaded;
    }

    // Build prompt — mention all photos when multiple images are present
    const imageCount = images?.length ?? 0;
    let prompt: string;
    if (imageCount > 1) {
      prompt = userText
        ? `用户发送了 ${imageCount} 张照片，请按顺序逐一查看并综合分析（第一张到第 ${imageCount} 张都要看，不要只看其中一张）\n\n用户的问题: ${userText}`
        : `用户发送了 ${imageCount} 张照片，请按顺序逐一查看并综合分析。第一张到第 ${imageCount} 张都要看，不要只看其中一张。`;
    } else if (imageCount === 1) {
      prompt = userText || '请分析这张图片';
    } else if (imageItems.length > 0) {
      // Images were sent but all downloads failed
      prompt = userText || '[图片下载失败，请重新发送]';
    } else {
      prompt = userText;
    }
    if (fileItems.length > 0) {
      // Download all files and append to prompt
      for (const fItem of fileItems) {
        const filePath = await downloadFile(fItem);
        if (filePath) {
          const fileName = fItem.file_item?.file_name || basename(filePath);
          prompt = `${prompt}\n\n用户同时发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请一并读取此文件进行分析。`;
        }
      }
    }

    let textBuffer = '';
    let anySent = false;
    let lastSentTime = Date.now();

    const MIN_BATCH_FLUSH_LEN = 30;
    const SOFT_FLUSH_LIMIT = 3800;

    /** Check if buffer ends at a structural boundary (double newline or horizontal rule). */
    function endsWithStructuralBoundary(text: string): boolean {
      return /\n\n\s*$/.test(text) || /\n[-*_]{3,}\s*$/.test(text);
    }

    // Serial promise chain — each flushText() appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function flushText(): Promise<void> {
      // Capture and clear synchronously to prevent race condition
      const captured = textBuffer.trim();
      textBuffer = '';
      if (!captured) return flushChain;

      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(captured);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
        anySent = true;
        lastSentTime = Date.now();
      }).catch((err) => {
        logger.error('flushText send failed', { error: err instanceof Error ? err.message : String(err) });
      });
      return flushChain;
    }

    // Safety net: send keepalive if nothing was sent for 5 minutes
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    const SILENCE_MESSAGES = [
      '我还在处理中，这个问题有点复杂，请再稍等一下',
      '正在努力干活中，马上就有结果了，请稍等片刻',
      '有点复杂正在处理，再给我一点时间，很快就好',
      '快好了别着急，正在收尾阶段，马上给你回复',
      '还在跑呢，任务量比较大，不过马上就能出结果了',
      '任务比想象的复杂一些，再等等我，正在全力处理',
      '正在处理中，进展顺利，再等一会儿就好',
      '还没完不过已经快了，再给我一分钟就能搞定',
      '我在认真思考这个问题，请再稍等一会儿',
      '稍微有点棘手，不过已经快解决了，再等我一下',
    ];
    flushTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    // Smart resume: don't resume if session is >30 minutes old
    // This prevents context bloat causing output token limit errors
    // Also don't resume for image messages to avoid seeing old cached images
    // Also don't resume if the last assistant response was an error (e.g. API error messages)
    const shouldResume = (() => {
      if (!session.sdkSessionId) return false;
      if (images && images.length > 0) {
        logger.info('Image message, not resuming to avoid old cached images');
        return false;
      }
      const lastMessageTime = session.chatHistory?.[session.chatHistory.length - 1]?.timestamp;
      if (!lastMessageTime) return true;
      const sessionAgeMs = Date.now() - lastMessageTime;
      const MAX_SESSION_AGE_MS = 30 * 60 * 1000; // 30 minutes
      if (sessionAgeMs > MAX_SESSION_AGE_MS) {
        logger.info('Session too old, not resuming', { ageMinutes: Math.round(sessionAgeMs / 60000) });
        return false;
      }
      // Don't resume if last assistant message was an API error
      const lastMsg = session.chatHistory?.[session.chatHistory.length - 1];
      if (lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string' && lastMsg.content.startsWith('API Error:')) {
        logger.info('Last message was an API error, not resuming', { preview: lastMsg.content.slice(0, 60) });
        return false;
      }
      return true;
    })();

    // Build chat history context for resume-failed scenarios.
    // When --resume is unavailable, inject recent conversation context so MiMo
    // isn't starting from zero. Limited to ~5 most recent exchanges (10 messages).
    const chatHistoryCtx = (() => {
      if (shouldResume) return '';
      const history = session.chatHistory || [];
      if (history.length === 0) return '';
      // Take last 3 user-assistant pairs (up to 6 messages)
      const recent = history.slice(-6);
      const lines = recent.map(m =>
        `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 200)}`
      );
      logger.info('Injecting chat history for resume fallback', { messageCount: recent.length });
      return `\n\n以下是之前与用户的对话上下文，帮助你理解对话背景：\n${lines.join('\n')}`;
    })();

    // Use Fable model (mimo-v2.5) for wechat - it has strong vision capabilities
    const effectiveModel = session.model || 'fable';
    const effectiveEffort = session.effort; // undefined = inherit from env

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: shouldResume ? session.sdkSessionId : undefined,
      model: effectiveModel,
      effort: effectiveEffort,
      systemPrompt: [
        // 1. Persona + temporal anchor
        `你叫小Mo，是用户身边靠谱的私人助手。说话温和体贴，像朋友在微信里聊天。今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}。`,
        // 2. Tone & banned phrases
        '说话用口语，短句为主。禁止使用：首先、其次、最后、综上所述、总而言之、值得注意的是、根据您的需求、很高兴为您服务、希望以上信息对您有帮助。用"嗯""啊""对了""说白了"这些口语词替代。每次回复最多问一个问题，大多数时候直接做事不用问。禁止在结尾说"还有什么需要帮忙的吗""还需要进一步了解什么吗"之类的客套话，聊完就聊完。',
        // 3. Accuracy with natural hedging
        '不确定的事情就说"我印象中是…你确认一下"，别猜别编。做不到的事直接说"这个我搞不定"，不用解释原因。如果用户纠正了你，先认真想一下再回应，别急着认错也别硬杠。',
        // 4. WeChat chat style + emotional awareness
        '像微信聊天一样回复：短句为主，一次说一两件事。正常聊天不用加粗、不用列表、不用markdown格式。展示数据或对比时可以用markdown表格，表格之外不滥用格式。用户表达困扰时先共情（如"听起来挺烦的""确实不容易"），再帮忙。用户说谢谢时自然回应（如"哈哈搞定了就好"），别说"很高兴能帮到您"。工具用一次就好，不行就直接告诉用户，别反复试。',
        // 5. Image/file push
        '保存截图或文件后，回复里一定要带上 ![描述](/完整路径.png) 这个写法，系统看到就会自动把图片发给用户。如果用户说没收到图片，重新输出一次这个写法就行，不要说"我没法发送图片"之类的话。',
        // 6. Context isolation
        '系统上下文里可能有之前的聊天记录，那些只是背景参考，不是用户现在说的话。只回应当前这条消息的内容。',
        // 7. Image handling (conditional)
        images?.length
          ? '本条消息已附带用户发送的图片，直接看图回复。'
          : '',
        chatHistoryCtx,
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: async (delta: string) => {
        textBuffer += delta;

        // Flush at structural boundaries (only if buffer is substantial) or when approaching size limit
        const shouldFlush =
          (endsWithStructuralBoundary(textBuffer) && textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN)
          || textBuffer.length > SOFT_FLUSH_LIMIT;

        if (shouldFlush) {
          await flushText();
        }
      },
      onTurnEnd: async (_stopReason: string) => {
        // Flush remaining text at turn boundary (e.g. after tool_use or end_turn)
        if (textBuffer.trim().length >= MIN_BATCH_FLUSH_LEN || textBuffer.length > SOFT_FLUSH_LIMIT) {
          await flushText();
        }
      },
    };

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session or 422 thinking-chain break),
    // retry without resume + inject chatHistory as fallback context
    const isSessionCorrupted = queryOptions.resume && (
      result.error ||
      (result.text && /\b422\b|No choices/.test(result.text.slice(0, 200)))
    );
    if (isSessionCorrupted) {
      logger.warn('Session corrupted, retrying without resume', {
        error: result.error,
        textPreview: result.text?.slice(0, 100),
        sessionId: queryOptions.resume,
      });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;

      // If no images in current query but activeImages exist, use them as fallback
      if (!queryOptions.images && session.activeImages?.length) {
        queryOptions.images = session.activeImages;
      }

      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // If this query was aborted (redirect or /stop), skip all post-processing.
    // provider.ts resolves (not rejects) on abort, so we must explicitly check.
    if (abortController.signal.aborted) {
      logger.info('Query was aborted, skipping post-processing');
      return;
    }

    // Stop keepalive timer and flush any remaining buffered text
    clearInterval(flushTimer);
    await flushText();

    // Record result in chat history for session resume
    const assistantText = result.text || '';
    if (assistantText) {
      sessionStore.addChatMessage(session, 'assistant', assistantText);
    }

    // If nothing was streamed, send full result text as fallback
    if (!anySent && result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      const chunks = splitMessage(result.text);
      for (const chunk of chunks) {
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, 'Claude 处理请求时出错，请稍后重试。');
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'Claude 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;

    // Save activeImages for resume fallback (only after first successful query with images)
    if (images && images.length > 0) {
      session.activeImages = images;
    }

    // Auto-push deliverable files mentioned in Claude's response
    if (result.text) {
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const detectedPaths = extractFilePathsFromText(result.text, cwd);
      const { existsSync } = await import('node:fs');
      const { extname } = await import('node:path');
      // Deduplicate: same path may appear as raw path and inside ![]() markdown
      const uniquePaths = [...new Set(detectedPaths)];
      const pushable = uniquePaths.filter(f => {
        const ext = extname(f).toLowerCase();
        return AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(f);
      });
      if (pushable.length === 0) {
        logger.debug('No pushable file paths in response, skipping auto-push', { detectedCount: detectedPaths.length, dupesRemoved: detectedPaths.length - uniquePaths.length });
      }
      if (pushable.length > 0) {
        const failedFiles: string[] = [];
        for (const filePath of pushable) {
          try {
            await sender.sendFile(fromUserId, contextToken, filePath);
          } catch {
            failedFiles.push(filePath);
          }
        }
        if (failedFiles.length > 0) {
          // Server-side rate limit requires longer cooldown (observed ret:-2 even after 9s backoff)
          for (let attempt = 0; attempt < 3; attempt++) {
            const delay = (attempt + 1) * 15_000;
            logger.warn(`Rate-limited, retrying ${failedFiles.length} file(s) in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, delay));
            const stillFailed: string[] = [];
            for (const filePath of failedFiles) {
              try {
                await sender.sendFile(fromUserId, contextToken, filePath);
              } catch {
                stillFailed.push(filePath);
              }
            }
            if (stillFailed.length === 0) break;
            failedFiles.length = 0;
            failedFiles.push(...stillFailed);
          }
          if (failedFiles.length > 0) {
            logger.error('File delivery failed after all retries', { files: failedFiles });
            await sender.sendText(fromUserId, contextToken, `文件推送失败（服务端限频），请稍后重试。`).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    clearInterval(flushTimer);
    stopTyping();
    // Only clean up state if no redirect has replaced us.
    // A redirect creates a new abortController, so this guard detects replacement.
    if (activeControllers.get(account.accountId) === abortController) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      activeControllers.delete(account.accountId);
    }
    // Only clear lastQueryCtx if we weren't aborted — the new sendToClaude
    // already set its own value at the top of its execution.
    if (!abortController.signal.aborted) {
      lastQueryCtx = null;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else if (command === 'start' || command === undefined) {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
} else {
  console.error('未知命令: "' + command + '" — 可用命令: setup, start');
  process.exit(1);
}
