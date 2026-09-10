import { schema } from 'loro-mirror';

// Moor session format v1. The host validates all browser edits before persistence.
// Content items are atomic values; turn identity and lifecycle use separate CRDT fields.
export const sessionDocSchema = schema({
  session: schema.LoroMap({ id: schema.String() }),
  history: schema.LoroList(
    schema.LoroMap({
      id: schema.String(),
      role: schema.String<'user' | 'assistant'>(),
      timestamp: schema.String(),
      userId: schema.String({ required: false }),
      userTurnId: schema.String({ required: false }),
      status: schema.String({ required: false }),
      read: schema.Boolean({ required: false }),
      finished: schema.Boolean(),
      items: schema.LoroList(schema.Any(), undefined, { required: false }),
      inputConfig: schema.Any({ required: false }),
      fileDiff: schema.Any({ required: false }),
    }),
    (turn) => turn.id,
  ),
});
