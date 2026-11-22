import { z } from 'zod';

export const uuid = z.uuid();
export const title = z.string().trim().min(1).max(160)
  .refine((value) => !/[\u0000\uD800-\uDFFF]/u.test(value), 'Title contains invalid Unicode');
const version = z.number().int().min(1).max(2147483647);
const revision = z.string().regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');

const operation = z.strictObject({ id: uuid, entityId: uuid, title });
export const taskUpdate = operation.extend({
  kind: z.literal('task.update'), version, done: z.boolean(),
  assigneeId: uuid.nullable(), resolves: uuid.optional(),
});
export const mutation = z.discriminatedUnion('kind', [
  operation.extend({ kind: z.literal('project.create') }),
  operation.extend({
    kind: z.literal('task.create'), projectId: uuid, done: z.boolean(), assigneeId: uuid.nullable(),
  }),
  taskUpdate,
  z.strictObject({ kind: z.literal('conflict.keep'), id: uuid, entityId: uuid, resolves: uuid, title }),
]);

const task = z.object({
  id: uuid, projectId: uuid, title, done: z.boolean(), assigneeId: uuid.nullable(), version,
});
const project = z.object({ id: uuid, title });
const role = z.enum(['admin', 'editor', 'viewer']);
export const profileSchema = z.object({
  id: uuid, name: z.string(), expiresAt: z.iso.datetime(), workspaces: z.array(z.object({ id: uuid, name: z.string(), role })),
});
const conflictReceipt = z.object({ status: z.literal('conflict'), current: task, revision: revision.optional() });
export const receiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), revision }),
  conflictReceipt,
  z.object({ status: z.literal('rejected'), reason: z.string() }),
]);
export const snapshotSchema = z.object({
  revision,
  role,
  projects: z.array(project),
  tasks: z.array(task),
  members: z.array(z.object({ id: uuid, name: z.string() })),
  activity: z.array(z.object({
    revision, actor: z.string(), kind: z.string(), title, at: z.iso.datetime(), resolves: uuid.nullable(),
  })),
  conflicts: z.array(z.object({ operation: taskUpdate, receipt: conflictReceipt })),
});

export const snapshotCacheSchema = snapshotSchema.extend({
  role: role.optional(),
  conflicts: snapshotSchema.shape.conflicts.default([]),
});
export type CachedSnapshot = z.infer<typeof snapshotCacheSchema>;

export type Mutation = z.infer<typeof mutation>;
export type Task = z.infer<typeof task>;
export type Role = z.infer<typeof role>;
export type Profile = z.infer<typeof profileSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
