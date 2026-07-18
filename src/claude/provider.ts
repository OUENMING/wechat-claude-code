import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when an assistant turn ends, with its stop_reason
   *  ('tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | ...).
   *  Use to decide whether the turn's text is interstitial progress or final answer. */
  onTurnEnd?: (stopReason: string) => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
  /** Optional reasoning effort level override (none/low/medium/high/max). */
  effort?: string;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onTurnEnd,
    abortController,
    effort,
  } = options;

  logger.info("Starting Claude CLI query", {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Build CLI arguments
  const args: string[] = [
    '-p', '-',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  // Handle images: build stream-json input with base64 content blocks
  // (same approach as Pikiloom's buildClaudeUserMessage — single round trip)
  const hasImages = images && images.length > 0;
  if (hasImages) args.push('--input-format', 'stream-json');

  let stdinInput: string;
  if (hasImages) {
    const content: any[] = [];
    for (const img of images!) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.source.media_type,
          data: img.source.data,
        },
      });
    }
    content.push({ type: 'text', text: prompt });
    stdinInput = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    logger.info("Built stream-json input with images", {
      imageCount: images!.length,
      contentBlockCount: content.length,
      stdinLength: stdinInput.length,
    });
  } else {
    stdinInput = prompt;
  }

  // Accumulators
  let sessionId = '';
  const textParts: string[] = [];
  let errorMessage: string | undefined;
  let child: ChildProcess | undefined;
  let settled = false;
  let lastStatus = '';
  // Tool loop detection: abort if same tool called >=8x without text output
  let lastToolName = '';
  let consecutiveToolCalls = 0;
  let thinkingSinceLastTool = false;
  const MAX_CONSECUTIVE_TOOL_CALLS = 15;

  const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const envWithMaxTokens = {
        ...process.env,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '320000',  // 提高到320k，避免复杂场景（多轮工具调用+截图分析）超限
        ...(options.effort && { CLAUDE_CODE_EFFORT_LEVEL: options.effort }),
      };
      logger.info("Spawning Claude CLI", { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: envWithMaxTokens.CLAUDE_CODE_MAX_OUTPUT_TOKENS } });

      child = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: envWithMaxTokens,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn claude: ${msg}` });
      return;
    }

    // Write prompt to stdin and close
    logger.info("Writing prompt to stdin", { stdinPreview: stdinInput.slice(0, 200), stdinLength: stdinInput.length, streamJson: hasImages });
    child.stdin!.write(stdinInput);
    child.stdin!.end();

    // Timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Claude CLI query timed out, killing process');
      child!.kill('SIGTERM');
      // SIGKILL fallback if process doesn't respond to SIGTERM
      setTimeout(() => { if (!settled) child?.kill('SIGKILL'); }, 5_000).unref();
      const partialText = textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId,
        error: partialText ? undefined : 'Claude query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Claude CLI query aborted');
      child!.kill('SIGTERM');
      // SIGKILL fallback if process doesn't respond to SIGTERM
      setTimeout(() => { if (!settled) child?.kill('SIGKILL'); }, 5_000).unref();
      const partialText = textParts.join('\n').trim();
      finish({ text: partialText, sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    // Parse NDJSON from stdout
    let skillInputAccum = '';
    let trackingSkill = false;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        // Skip unparseable lines
        logger.debug('Unparseable line from Claude CLI', { line: line.slice(0, 100) });
        return;
      }

      logger.debug('Claude CLI output', { type: obj.type, subtype: obj.subtype || 'none' });

      switch (obj.type) {
        case 'system': {
          if (obj.subtype === 'init') {
            if (obj.session_id) {
              sessionId = obj.session_id;
            }
            logger.info('Claude CLI init', { model: obj.model, cwd: obj.cwd });
          } else if (obj.subtype === 'thinking_tokens') {
            // Track thinking state but don't push to WeChat text buffer.
            // WeChat typing indicator + keepalive timer handle user feedback.
            lastStatus = 'thinking';
            thinkingSinceLastTool = true;
          } else if (obj.subtype === 'api_retry') {
            // Track retry state but don't push to WeChat text buffer.
            // WeChat typing indicator + keepalive timer already handle user feedback.
            lastStatus = 'api_retry';
          }
          break;
        }
        case 'assistant': {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text ?? '')
              .join('');
            if (text) textParts.push(text);
          }
          break;
        }
        case 'stream_event': {
          const evt = obj.event;
          if (evt?.type === 'message_start') {
            logger.info('Claude CLI message_start', { apiModel: evt.message?.model });
          }
          if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            const toolName = evt.content_block.name;
            logger.info('Claude CLI tool_use start', { tool: toolName });
            if (toolName === 'Skill') {
              trackingSkill = true;
              skillInputAccum = '';
            } else if (toolName && toolName !== 'Skill') {
              // Track tool call state (don't push to WeChat text buffer).
              lastStatus = toolName;
              // Tool loop detection: abort if same tool called too many times without text output
              if (toolName === lastToolName) {
                // Thinking tokens between same-tool calls = model is reasoning, not stuck.
                // Reset BEFORE incrementing so thinking-aware restarts never trip the threshold.
                if (thinkingSinceLastTool) {
                  consecutiveToolCalls = 0;
                }
                thinkingSinceLastTool = false;
                consecutiveToolCalls++;
                if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOL_CALLS) {
                  logger.warn('Tool loop detected, aborting query', { tool: toolName, count: consecutiveToolCalls });
                  if (abortController) abortController.abort();
                  child?.kill('SIGTERM');
                  // SIGKILL fallback if process doesn't respond to SIGTERM
                  setTimeout(() => { if (!settled) child?.kill('SIGKILL'); }, 5_000).unref();
                  if (onText) Promise.resolve(onText('\n\n⚠️ 检测到工具重复调用，已自动终止。请简化指令后重试。\n')).catch(() => {});
                }
              } else {
                // Switched to a different tool — reset the streak. Also clear the
                // thinking flag so the reasoning residue (from before the tool switch)
                // doesn't grant a free reset on the new tool's first repeat.
                lastToolName = toolName;
                consecutiveToolCalls = 1;
                thinkingSinceLastTool = false;
              }
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const delta: string = evt.delta.text;
            // Reset status tracking when real text starts arriving
            if (lastStatus && !lastStatus.startsWith('thinking')) lastStatus = '';
            // Reset tool loop counter when meaningful text output arrives
            if (delta.trim().length > 10) {
              lastToolName = '';
              consecutiveToolCalls = 0;
            }
            if (delta && onText) {
              Promise.resolve(onText(delta)).catch(() => {});
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && trackingSkill) {
            skillInputAccum += evt.delta.partial_json ?? '';
            try {
              const parsed = JSON.parse(skillInputAccum);
              if (parsed.skill) {
                // Skill detected - log it but don't push to WeChat text buffer.
                logger.info('Skill call detected', { skill: parsed.skill });
                trackingSkill = false;
              }
            } catch {
              // JSON not complete yet, keep accumulating
            }
          } else if (evt?.type === 'content_block_stop') {
            trackingSkill = false;
          } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
            if (onTurnEnd) Promise.resolve(onTurnEnd(evt.delta.stop_reason)).catch(() => {});
          }
          break;
        }
        case 'result': {
          if (obj.result && typeof obj.result === 'string') {
            const combined = textParts.join('');
            if (!combined.includes(obj.result)) {
              textParts.push(obj.result);
            }
          }
          if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
            const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
            errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
            logger.error('CLI returned error result', { errors });
          }
          break;
        }
        default:
          break;
      }
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      logger.info('Claude CLI process closed', {
        code,
        textLength: textParts.join('').length,
        hasError: !!errorMessage,
        stderrLength: stderrParts.join('').length,
      });

      if (code !== 0 && code !== null && !textParts.length && !errorMessage) {
        const stderr = stderrParts.join('').trim();
        errorMessage = stderr || `claude exited with code ${code}`;
        logger.error('Claude CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = textParts.join('\n').trim();

      if (!fullText && !errorMessage) {
        errorMessage = 'Claude returned an empty response.';
      }

      logger.info("Claude CLI query completed", {
        sessionId,
        textLength: fullText.length,
        hasError: !!errorMessage,
      });

      finish({
        text: fullText,
        sessionId,
        error: errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId, error: `Failed to spawn claude: ${err.message}` });
    });
  });
}
