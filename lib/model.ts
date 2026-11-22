import { z } from 'zod';

export const uuid = z.uuid();
export const title = z.string().trim().min(1).max(160);

const operation = z.strictObject({ id: uuid, entityId: uuid, title });
export const mutation = z.discriminatedUnion('kind', [
  operation.extend({ kind: z.literal('project.create') }),
  operation.extend({
    kind: z.literal('task.create'), projectId: uuid, done: z.boolean(), assigneeId: uuid.nullable(),
  }),
  operation.extend({
    kind: z.literal('task.update'), version: z.number().int().positive(), done: z.boolean(),
    assigneeId: uuid.nullable(), resolves: uuid.optional(),
  }),
]);

export type Mutation = z.infer<typeof mutation>;
export type Task = {
  id: string; projectId: string; title: string; done: boolean; assigneeId: string | null; version: number;
};
export type Project = { id: string; title: string };
export type Role = 'admin' | 'editor' | 'viewer';
export type Profile = {
  id: string; name: string; workspaces: { id: string; name: string; role: Role }[];
};
export type Snapshot = {
  revision: string;
  projects: Project[];
  tasks: Task[];
  members: { id: string; name: string }[];
  activity: { revision: string; actor: string; kind: string; title: string; at: string; resolves?: string }[];
};
export type Receipt =
  | { status: 'applied'; revision: string }
  | { status: 'conflict'; current: Task }
  | { status: 'rejected'; reason: string };
