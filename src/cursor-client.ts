/**
 * cursor-client.ts - 上游请求客户端
 *
 * 当前按 z.py 的链路工作：
 * 1. 发送请求到 https://vercel.com/api/ai-chat
 * 2. 将现有 CursorChatRequest 转成 vercel ai-chat 请求体
 * 3. 流式解析 SSE 响应中的 text-delta
 * 4. 自动重试（最多 2 次）
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { getProxyFetchOptions } from './proxy-agent.js';
import { randomBytes, randomUUID } from 'crypto';

const UPSTREAM_CHAT_API = 'https://vercel.com/api/ai-chat';

function generateIdentity(): { sessionId: string; anonymousId: string } {
    return {
        sessionId: randomBytes(20).toString('base64'),
        anonymousId: randomUUID().replace(/-/g, '').slice(0, 21),
    };
}

function buildUpstreamHeaders(): Record<string, string> {
    const config = getConfig();
    const { sessionId, anonymousId } = generateIdentity();

    return {
        'Content-Type': 'application/json',
        'accept': '*/*',
        'origin': 'https://vercel.com',
        'referer': 'https://vercel.com/docs',
        'user-agent': config.fingerprint.userAgent,
        'cookie': `vercel.com_session_id=${sessionId}; _v-anonymous-id=${anonymousId}; _v-anonymous-id-renewed=1;`,
    };
}

function buildUpstreamRequest(req: CursorChatRequest): Record<string, unknown> {
    return {
        currentRoute: '/docs',
        id: randomUUID().slice(0, 16),
        messages: req.messages,
        trigger: req.trigger || 'submit-message',
    };
}

export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
): Promise<void> {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk, externalSignal);
            return;
        } catch (err) {
            if (externalSignal?.aborted) throw err;
            if (err instanceof Error && err.message === 'DEGENERATE_LOOP_ABORTED') return;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Upstream] 请求失败 (${attempt}/${maxRetries}): ${msg.substring(0, 160)}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    externalSignal?: AbortSignal,
): Promise<void> {
    const config = getConfig();
    const controller = new AbortController();

    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
    }

    const IDLE_TIMEOUT_MS = config.timeout * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.warn(`[Upstream] 空闲超时（${config.timeout}s 无新数据），中止请求`);
            controller.abort();
        }, IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();

    try {
        const fetchOptions = getProxyFetchOptions();
        const resp = await fetch(UPSTREAM_CHAT_API, {
            method: 'POST',
            headers: buildUpstreamHeaders(),
            body: JSON.stringify(buildUpstreamRequest(req)),
            signal: controller.signal,
            ...fetchOptions,
        } as any);

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Upstream API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Upstream API 响应无 body');
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let lastDelta = '';
        let repeatCount = 0;
        const REPEAT_THRESHOLD = 8;
        let degenerateAborted = false;

        let tagBuffer = '';
        let htmlRepeatAborted = false;
        const HTML_TOKEN_RE = /(<\/?[a-z][a-z0-9]*\s*\/?>|&[a-z]+;)/gi;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data || data === '[DONE]') continue;

                try {
                    const rawEvent = JSON.parse(data) as Record<string, unknown>;
                    const event: CursorSSEEvent = {
                        type: String(rawEvent.type || ''),
                        delta: typeof rawEvent.delta === 'string' ? rawEvent.delta : undefined,
                    };

                    if (event.type === 'text-delta' && event.delta) {
                        const trimmedDelta = event.delta.trim();
                        if (trimmedDelta.length > 0 && trimmedDelta.length <= 20) {
                            if (trimmedDelta === lastDelta) {
                                repeatCount++;
                                if (repeatCount >= REPEAT_THRESHOLD) {
                                    console.warn(`[Upstream] ⚠️ 检测到退化循环: "${trimmedDelta}" 已连续重复 ${repeatCount} 次，中止流`);
                                    degenerateAborted = true;
                                    reader.cancel();
                                    break;
                                }
                            } else {
                                lastDelta = trimmedDelta;
                                repeatCount = 1;
                            }
                        } else {
                            lastDelta = '';
                            repeatCount = 0;
                        }

                        tagBuffer += event.delta;
                        const tagMatches = [...tagBuffer.matchAll(new RegExp(HTML_TOKEN_RE.source, 'gi'))];
                        if (tagMatches.length > 0) {
                            const lastTagMatch = tagMatches[tagMatches.length - 1];
                            tagBuffer = tagBuffer.slice(lastTagMatch.index! + lastTagMatch[0].length);
                            for (const m of tagMatches) {
                                const token = m[0].toLowerCase();
                                if (token === lastDelta) {
                                    repeatCount++;
                                    if (repeatCount >= REPEAT_THRESHOLD) {
                                        console.warn(`[Upstream] ⚠️ 检测到 HTML token 重复: "${token}" 已连续重复 ${repeatCount} 次，中止流`);
                                        htmlRepeatAborted = true;
                                        reader.cancel();
                                        break;
                                    }
                                } else {
                                    lastDelta = token;
                                    repeatCount = 1;
                                }
                            }
                            if (htmlRepeatAborted) break;
                        } else if (tagBuffer.length > 20) {
                            tagBuffer = '';
                        }
                    }

                    onChunk(event);
                } catch {
                    // ignore malformed line
                }
            }

            if (degenerateAborted || htmlRepeatAborted) break;
        }

        if (degenerateAborted) throw new Error('DEGENERATE_LOOP_ABORTED');
        if (htmlRepeatAborted) throw new Error('HTML_REPEAT_ABORTED');

        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data && data !== '[DONE]') {
                try {
                    const rawEvent = JSON.parse(data) as Record<string, unknown>;
                    const event: CursorSSEEvent = {
                        type: String(rawEvent.type || ''),
                        delta: typeof rawEvent.delta === 'string' ? rawEvent.delta : undefined,
                    };
                    onChunk(event);
                } catch {
                    // ignore trailing malformed chunk
                }
            }
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

export async function sendCursorRequestFull(req: CursorChatRequest): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }> {
    let fullText = '';
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
        if (event.messageMetadata?.usage) {
            usage = event.messageMetadata.usage;
        }
    });

    return { text: fullText, usage };
}
