import { z } from 'zod';

const textPartSchema = z.object({
  type: z.string(),
  text: z.string().optional()
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'developer', 'tool']).catch('user'),
      content: z.union([z.string(), z.array(textPartSchema), z.null()]).optional()
    })
  ),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional()
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

function stringifyContent(content: ChatCompletionRequest['messages'][number]['content']): string {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join('\n');
}

export function buildPrompt(request: ChatCompletionRequest): string {
  const lines = [
    'You are acting as a local LLM provider behind an OpenAI-compatible API.',
    'Do not edit files, run shell commands, browse, or use tools. Answer only the user request.',
    'If the request asks for JSON, return only valid JSON.',
    ''
  ];

  for (const message of request.messages) {
    const content = stringifyContent(message.content).trim();
    if (!content) {
      continue;
    }

    lines.push(`[${message.role.toUpperCase()}]`);
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function toChatCompletionResponse(model: string, content: string) {
  const created = Math.floor(Date.now() / 1000);

  return {
    id: `chatcmpl_codex_${created}_${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}
