import { z } from 'zod';
import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
import {
  INTERACTION_VERSION,
  QUESTION_LIMITS,
  questionRequestSchema,
  questionValueError,
  validateQuestionAnswer,
  type QuestionAnswer,
  type QuestionRequest,
} from '../interaction-protocol';

export type ElicitationBinding = Pick<
  QuestionRequest,
  'workspaceId' | 'localProjectId' | 'sessionId' | 'expectedTurnId' | 'requestId'
> & { nativeSessionId: string };
export type NormalizedElicitation =
  | { status: 'question'; request: QuestionRequest }
  | {
      status: 'unsupported';
      reason: 'unsupported-mode' | 'unsupported-scope' | 'unsupported-field' | 'invalid-schema';
      response: { action: 'decline' };
    }
  | { status: 'cancelled'; reason: 'inactive-session'; response: { action: 'cancel' } };
const text = z.string().max(QUESTION_LIMITS.text);
const optionalText = z.string().max(4000).nullish();
const enumOption = z
  .object({
    const: text,
    title: z.string().max(1000),
    description: optionalText,
    _meta: z.unknown().optional(),
  })
  .strict();
const field = z
  .object({
    type: z.string().min(1).max(100),
    title: z.string().max(1000).nullish(),
    description: optionalText,
    minLength: z.number().int().nonnegative().nullish(),
    maxLength: z.number().int().nonnegative().nullish(),
    pattern: text.nullish(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).nullish(),
    minimum: z.number().finite().nullish(),
    maximum: z.number().finite().nullish(),
    minItems: z.number().int().nonnegative().nullish(),
    maxItems: z.number().int().nonnegative().nullish(),
    enum: z.array(text).max(QUESTION_LIMITS.options).nullish(),
    oneOf: z.array(enumOption).max(QUESTION_LIMITS.options).nullish(),
    items: z
      .object({
        type: z.string().optional(),
        enum: z.array(text).max(QUESTION_LIMITS.options).optional(),
        anyOf: z.array(enumOption).max(QUESTION_LIMITS.options).optional(),
        _meta: z.unknown().optional(),
      })
      .strict()
      .optional(),
    default: z.unknown().optional(),
    _meta: z.unknown().optional(),
  })
  .strict();
const schema = z
  .object({
    type: z.literal('object').optional(),
    title: z.string().max(1000).nullish(),
    description: optionalText,
    properties: z.record(z.unknown()).optional(),
    required: z.array(z.string()).max(QUESTION_LIMITS.fields).nullish(),
    _meta: z.unknown().optional(),
  })
  .strict();
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function options(
  values: string[] | null | undefined,
  titled: z.infer<typeof enumOption>[] | null | undefined,
) {
  if (values && titled) throw new Error('Multiple option definitions');
  return (
    titled?.map((option) => ({
      value: option.const,
      label: option.title,
      ...(option.description == null ? {} : { description: option.description }),
    })) ?? values?.map((value) => ({ value, label: value }))
  );
}

/** Accept only known form constraints. Unsupported constraints are never silently removed. */
export function normalizeElicitation(
  value: unknown,
  active?: ElicitationBinding,
): NormalizedElicitation {
  const request = object(value);
  const unsupported = (
    reason: Extract<NormalizedElicitation, { status: 'unsupported' }>['reason'],
  ): NormalizedElicitation => ({ status: 'unsupported', reason, response: { action: 'decline' } });
  if (!request || request.mode !== 'form') return unsupported('unsupported-mode');
  // ClientSideConnection.createElicitation does not expose the native JSON-RPC
  // prompt request ID. Never guess a request-scoped form belongs to this turn.
  if (typeof request.sessionId !== 'string' || request.requestId !== undefined)
    return unsupported('unsupported-scope');
  if (!active || request.sessionId !== active.nativeSessionId)
    return { status: 'cancelled', reason: 'inactive-session', response: { action: 'cancel' } };
  const parsed = schema.safeParse(request.requestedSchema);
  if (!parsed.success) return unsupported('invalid-schema');
  const rawProperties = object(object(request.requestedSchema)?.properties);
  if (
    rawProperties &&
    Object.keys(rawProperties).some((key) =>
      ['__proto__', 'constructor', 'prototype'].includes(key),
    )
  )
    return unsupported('invalid-schema');
  const properties = Object.entries(parsed.data.properties ?? {}),
    required = parsed.data.required ?? [];
  if (
    properties.length > QUESTION_LIMITS.fields ||
    new Set(required).size !== required.length ||
    required.some((id) => !Object.hasOwn(parsed.data.properties ?? {}, id))
  )
    return unsupported('invalid-schema');
  const fields: unknown[] = [];
  for (const [id, raw] of properties) {
    const parsedField = field.safeParse(raw);
    if (!parsedField.success) return unsupported('unsupported-field');
    const value = parsedField.data;
    if (value.pattern != null) return unsupported('unsupported-field');
    const allowed = new Set([
      'type',
      'title',
      'description',
      'default',
      '_meta',
      ...(value.type === 'string'
        ? ['minLength', 'maxLength', 'format', 'enum', 'oneOf', 'pattern']
        : value.type === 'array'
          ? ['minItems', 'maxItems', 'items']
          : value.type === 'number' || value.type === 'integer'
            ? ['minimum', 'maximum']
            : []),
    ]);
    if (Object.keys(object(raw)!).some((key) => !allowed.has(key)))
      return unsupported('unsupported-field');
    const base = {
      id,
      label: value.title || id,
      required: required.includes(id),
      ...(value.description == null ? {} : { description: value.description }),
      ...(value.default == null ? {} : { default: value.default }),
    };
    try {
      if (value.type === 'string') {
        const choices = options(value.enum, value.oneOf);
        const textConstraints = {
          id,
          label: base.label,
          required: base.required,
          kind: 'text' as const,
          minLength: value.minLength ?? 0,
          maxLength: Math.min(value.maxLength ?? QUESTION_LIMITS.text, QUESTION_LIMITS.text),
          ...(value.format == null ? {} : { format: value.format }),
        };
        // Every offered option must satisfy any additional string constraints.
        if (choices?.some((option) => questionValueError(textConstraints, option.value)))
          return unsupported('unsupported-field');
        fields.push(
          choices
            ? { ...base, kind: 'single-select', options: choices }
            : {
                ...base,
                ...textConstraints,
              },
        );
      } else if (value.type === 'array') {
        const items = value.items;
        if (!items || (items.type !== undefined && items.type !== 'string'))
          return unsupported('unsupported-field');
        const choices = options(items.enum, items.anyOf);
        if (!choices) return unsupported('unsupported-field');
        fields.push({
          ...base,
          kind: 'multi-select',
          options: choices,
          minItems: value.minItems ?? 0,
          maxItems: Math.min(value.maxItems ?? choices.length, choices.length),
        });
      } else if (value.type === 'boolean') fields.push({ ...base, kind: 'boolean' });
      else if (value.type === 'number' || value.type === 'integer')
        fields.push({
          ...base,
          kind: 'number',
          integer: value.type === 'integer',
          minimum: Math.max(value.minimum ?? -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER),
          maximum: Math.min(value.maximum ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        });
      else return unsupported('unsupported-field');
    } catch {
      return unsupported('unsupported-field');
    }
  }
  const question = questionRequestSchema.safeParse({
    interactionVersion: INTERACTION_VERSION,
    workspaceId: active.workspaceId,
    localProjectId: active.localProjectId,
    sessionId: active.sessionId,
    expectedTurnId: active.expectedTurnId,
    requestId: active.requestId,
    message: request.message,
    ...(parsed.data.title == null ? {} : { title: parsed.data.title }),
    ...(parsed.data.description == null ? {} : { description: parsed.data.description }),
    ...(request.toolCallId == null ? {} : { toolCallId: request.toolCallId }),
    fields,
  });
  return question.success
    ? { status: 'question', request: question.data }
    : unsupported('invalid-schema');
}

export function elicitationResponse(
  question: QuestionRequest,
  answer: unknown,
): CreateElicitationResponse {
  const validated = validateQuestionAnswer(question, answer).answer;
  return validated.action === 'accept'
    ? { action: 'accept', content: validated.values }
    : { action: validated.action };
}

/** ACP callback helper. The host owns request IDs, pending requests and receipts. */
export async function bridgeElicitation(
  value: unknown,
  getActive: () => ElicitationBinding | undefined,
  ask: (question: QuestionRequest) => Promise<QuestionAnswer>,
): Promise<CreateElicitationResponse> {
  const active = getActive(),
    before = active ? { ...active } : undefined,
    normalized = normalizeElicitation(value, before);
  if (normalized.status !== 'question') return normalized.response;
  const answer = await ask(normalized.request),
    after = getActive();
  if (
    !after ||
    !before ||
    (
      [
        'workspaceId',
        'localProjectId',
        'sessionId',
        'expectedTurnId',
        'requestId',
        'nativeSessionId',
      ] as const
    ).some((key) => before[key] !== after[key])
  )
    return { action: 'cancel' };
  return elicitationResponse(normalized.request, answer);
}

// Pinned Claude adapter 0.76.0 opts out of its legacy idle-new-turn fallback.
// Codex 1.11.0 cannot guarantee this contract and must not use this helper.
export function claudeSteerParams(nativeSessionId: string, prompt: string) {
  if (!nativeSessionId || !prompt.trim() || prompt.length > 16000)
    throw new Error('追加指令格式无效');
  return {
    sessionId: nativeSessionId,
    prompt: [{ type: 'text' as const, text: prompt }],
    _meta: { steering: { idleBehavior: 'promptRequired' as const } },
  };
}
