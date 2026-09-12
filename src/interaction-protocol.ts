import { z } from 'zod';
import { AppError, id } from './protocol';

export const INTERACTION_VERSION = 1;
export const QUESTIONS_FEATURE = 'questions-v1';
export const STEER_FEATURE = 'steer-v1';
export const QUESTION_LIMITS = { fields: 32, options: 100, text: 16000 } as const;
const safeNumber = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const fieldId = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !/[\x00-\x1f\x7f]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value),
  );
const text = z.string().max(QUESTION_LIMITS.text);
const option = z
  .object({
    value: text,
    label: z.string().max(1000),
    description: z.string().max(4000).optional(),
  })
  .strict();
const choices = z.array(option).min(1).max(QUESTION_LIMITS.options);
const common = {
  id: fieldId,
  label: z.string().min(1).max(1000),
  description: z.string().max(4000).optional(),
  required: z.boolean(),
};
const length = z.number().int().nonnegative().max(QUESTION_LIMITS.text);
const selectionCount = z.number().int().nonnegative().max(QUESTION_LIMITS.options);
export const questionFieldSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('text'),
        minLength: length,
        maxLength: length,
        format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
        default: text.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('single-select'),
        options: choices,
        default: text.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('multi-select'),
        options: choices,
        minItems: selectionCount,
        maxItems: selectionCount,
        default: z.array(text).max(QUESTION_LIMITS.options).optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('number'),
        integer: z.boolean(),
        minimum: safeNumber,
        maximum: safeNumber,
        default: safeNumber.optional(),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('boolean'), default: z.boolean().optional() }).strict(),
  ])
  .superRefine((field, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (
      'options' in field &&
      new Set(field.options.map((item) => item.value)).size !== field.options.length
    )
      reject('问答选项重复');
    if (field.kind === 'text' && field.minLength > field.maxLength) reject('文本长度范围无效');
    if (field.kind === 'number' && field.minimum > field.maximum) reject('数值范围无效');
    if (
      field.kind === 'multi-select' &&
      (field.minItems > field.maxItems || field.minItems > field.options.length)
    )
      reject('多选范围无效');
    if (field.default !== undefined) {
      const error = questionValueError(field, field.default);
      if (error) reject('默认回答无效：' + error);
    }
  });
export type QuestionField = z.infer<typeof questionFieldSchema>;
const scope = z.object({ workspaceId: id, localProjectId: id, sessionId: id, expectedTurnId: id });
export const questionRequestSchema = scope
  .extend({
    interactionVersion: z.literal(INTERACTION_VERSION),
    requestId: id,
    message: z.string().min(1).max(16000),
    title: z.string().max(1000).optional(),
    description: z.string().max(4000).optional(),
    toolCallId: z.string().min(1).max(1000).optional(),
    fields: z.array(questionFieldSchema).max(QUESTION_LIMITS.fields),
  })
  .strict()
  .refine(
    (request) => new Set(request.fields.map((field) => field.id)).size === request.fields.length,
    '问答字段重复',
  );
const answerValue = z.union([
  text,
  safeNumber,
  z.boolean(),
  z.array(text).max(QUESTION_LIMITS.options),
]);
export const questionAnswerSchema = scope
  .extend({
    interactionVersion: z.literal(INTERACTION_VERSION),
    operationId: id,
    requestId: id,
    answer: z.discriminatedUnion('action', [
      z.object({ action: z.literal('accept'), values: z.record(fieldId, answerValue) }).strict(),
      z.object({ action: z.literal('decline') }).strict(),
      z.object({ action: z.literal('cancel') }).strict(),
    ]),
  })
  .strict();
export type QuestionRequest = z.infer<typeof questionRequestSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export const questionReceiptSchema = scope
  .extend({
    interactionVersion: z.literal(INTERACTION_VERSION),
    operationId: id,
    requestId: id,
    accepted: z.literal(true),
    delivered: z.literal(true),
  })
  .strict();
export type QuestionReceipt = z.infer<typeof questionReceiptSchema>;

/** Validate schema semantics without executing Agent-provided patterns or coercing values. */
export function questionValueError(field: QuestionField, value: unknown): string | undefined {
  switch (field.kind) {
    case 'text': {
      if (typeof value !== 'string') return '需要文本';
      const size = [...value].length;
      if (size < field.minLength || size > field.maxLength || value.length > QUESTION_LIMITS.text)
        return '文本长度不符合要求';
      if (field.format === 'email' && !z.string().email().safeParse(value).success)
        return '邮箱格式无效';
      if (
        field.format === 'date-time' &&
        !z.string().datetime({ offset: true }).safeParse(value).success
      )
        return '日期时间格式无效';
      if (
        field.format === 'date' &&
        (!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
          Number.isNaN(Date.parse(value + 'T00:00:00Z')) ||
          new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
      )
        return '日期格式无效';
      if (field.format === 'uri') {
        try {
          new URL(value);
        } catch {
          return 'URI 格式无效';
        }
      }
      return;
    }
    case 'single-select':
      if (typeof value !== 'string' || !field.options.some((option) => option.value === value))
        return '请选择可用选项';
      return;
    case 'multi-select':
      if (
        !Array.isArray(value) ||
        value.length < field.minItems ||
        value.length > field.maxItems ||
        new Set(value).size !== value.length ||
        !value.every(
          (item) =>
            typeof item === 'string' && field.options.some((option) => option.value === item),
        )
      )
        return '多选回答不符合要求';
      return;
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.integer && !Number.isSafeInteger(value)) ||
        value < field.minimum ||
        value > field.maximum
      )
        return '数值不符合要求';
      return;
    case 'boolean':
      if (typeof value !== 'boolean') return '需要明确的是或否';
      return;
  }
}

export function validateQuestionAnswer(request: QuestionRequest, input: unknown): QuestionAnswer {
  const question = questionRequestSchema.parse(request),
    answer = questionAnswerSchema.parse(input);
  for (const key of [
    'workspaceId',
    'localProjectId',
    'sessionId',
    'expectedTurnId',
    'requestId',
  ] as const)
    if (answer[key] !== question[key]) throw new AppError(409, '问答请求已失效或不属于当前回合');
  if (answer.answer.action !== 'accept') return answer;
  const values = answer.answer.values;
  if (Object.keys(values).length > QUESTION_LIMITS.fields) throw new AppError(400, '回答字段过多');
  for (const key of Object.keys(values))
    if (!question.fields.some((field) => field.id === key))
      throw new AppError(400, '回答包含未知字段');
  for (const field of question.fields) {
    if (!Object.hasOwn(values, field.id)) {
      if (field.required) throw new AppError(400, '请回答必填问题：' + field.label);
      continue;
    }
    const error = questionValueError(field, values[field.id]);
    if (error) throw new AppError(400, field.label + '：' + error);
  }
  return answer;
}

export const steerRequestSchema = scope
  .extend({
    operationId: id,
    prompt: z
      .string()
      .min(1)
      .max(16000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export const steerReceiptSchema = scope
  .extend({
    operationId: id,
    accepted: z.literal(true),
    delivered: z.literal(true),
    activityBound: z.literal(true),
  })
  .strict();
export type SteerRequest = z.infer<typeof steerRequestSchema>;
export type SteerReceipt = z.infer<typeof steerReceiptSchema>;
