CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL CHECK (email = lower(email)),
  name text NOT NULL,
  password text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_by_user ON memberships(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS projects (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  title text NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS tasks (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL,
  assignee_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, assignee_id) REFERENCES memberships(workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS activity (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  revision bigint NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  title text NOT NULL,
  resolves uuid,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision)
);
CREATE TABLE IF NOT EXISTS receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  id uuid NOT NULL,
  entity_id uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, id)
);

-- Version 2. Legacy receipts still replay with the original result and fingerprint.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS proposal jsonb;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS resolved_by uuid;
CREATE INDEX IF NOT EXISTS receipts_open_conflicts ON receipts(workspace_id, actor_id, id)
  WHERE proposal IS NOT NULL AND resolved_by IS NULL;
