// Ordered schema migrations. Never edit a shipped migration; append a new one.
export const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT 'it',
    audience TEXT NOT NULL DEFAULT '',
    goals TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '{}',
    stage TEXT NOT NULL DEFAULT 'sources',
    outline_rev_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE resources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    filename TEXT NOT NULL,
    url TEXT,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL,
    included INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    page_count INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX resources_project_sha ON resources(project_id, sha256);

  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    quality TEXT NOT NULL,
    transcript TEXT,
    transcript_model TEXT,
    transcript_at TEXT
  );
  CREATE UNIQUE INDEX pages_resource_idx ON pages(resource_id, idx);
  -- Search over native text and transcripts. rowid mirrors pages.rowid.
  CREATE VIRTUAL TABLE pages_fts USING fts5(text, transcript, tokenize = 'unicode61 remove_diacritics 2');

  CREATE TABLE source_indexes (
    resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    entries TEXT NOT NULL
  );

  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    prerequisites TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    exam_sessions INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'normal'
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    resource_id TEXT,
    page_from INTEGER,
    page_to INTEGER,
    exam_group TEXT,
    exam_date TEXT,
    number TEXT,
    statement TEXT NOT NULL DEFAULT '',
    hint TEXT NOT NULL DEFAULT '',
    solution TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medio',
    topic_ids TEXT NOT NULL DEFAULT '[]',
    chapter_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    checks TEXT NOT NULL DEFAULT '[]',
    rev INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX questions_project ON questions(project_id, kind);

  CREATE TABLE outline_revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    outline TEXT NOT NULL,
    origin TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    approved_at TEXT
  );

  CREATE TABLE content_revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    markdown TEXT NOT NULL,
    origin TEXT NOT NULL,
    model TEXT,
    parent_rev_id TEXT,
    status TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX content_node ON content_revisions(project_id, node_id, status);

  CREATE TABLE evidence_packets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    query TEXT NOT NULL,
    answer TEXT NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX evidence_node ON evidence_packets(project_id, node_id);

  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    origin TEXT NOT NULL,
    spec TEXT,
    caption TEXT NOT NULL DEFAULT '',
    alt TEXT NOT NULL DEFAULT '',
    checks TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE enrichments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    checks TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    snapshot TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    -- Unique per run; lets handlers enqueue idempotently.
    key TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    pool TEXT NOT NULL DEFAULT 'local',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_owner TEXT,
    lease_until INTEGER,
    retry_at INTEGER,
    provider TEXT,
    result TEXT,
    error TEXT,
    wait_reason TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE UNIQUE INDEX tasks_run_key ON tasks(run_id, key);
  CREATE INDEX tasks_state ON tasks(state);

  CREATE TABLE task_deps (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dep_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, dep_id)
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    run_id TEXT,
    task_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    run_id TEXT,
    task_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    role TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE review_issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT,
    question_id TEXT,
    rev_id TEXT,
    source TEXT NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    quote TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    suggestion TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX issues_project ON review_issues(project_id, status);

  CREATE TABLE exports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    approved INTEGER NOT NULL,
    report TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE notebooks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE notebook_sources (
    resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    remote_source_id TEXT,
    sha256 TEXT NOT NULL,
    -- 'uploading' is recorded before the remote call so a crash leaves an ambiguous, checkable state.
    status TEXT NOT NULL
  );
  `,
  // 2: producing task on AI revisions (checkpoint), topic-map fingerprint.
  `
  ALTER TABLE content_revisions ADD COLUMN task_id TEXT;
  CREATE INDEX content_task ON content_revisions(task_id) WHERE task_id IS NOT NULL;
  ALTER TABLE projects ADD COLUMN topic_fingerprint TEXT;
  `,
];
