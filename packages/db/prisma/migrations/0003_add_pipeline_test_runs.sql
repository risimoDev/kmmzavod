-- Pipeline test runs (admin pipeline test history)
CREATE TABLE pipeline_test_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by_id   UUID NOT NULL REFERENCES users(id),
    product_name    TEXT NOT NULL,
    prompt          TEXT NOT NULL DEFAULT '',
    language        TEXT NOT NULL DEFAULT 'ru',
    avatar_id       TEXT NOT NULL,
    voice_id        TEXT NOT NULL,
    layout_template TEXT NOT NULL,
    target_duration INT NOT NULL DEFAULT 30,
    subtitle_style  TEXT,

    -- Generated content
    title           TEXT,
    full_script     TEXT,

    -- Result
    output_url      TEXT,
    output_key      TEXT,
    duration_sec    DOUBLE PRECISION,
    file_size_bytes INT,
    elapsed_ms      INT,

    -- Full params snapshot for re-creation
    params          JSONB NOT NULL DEFAULT '{}',

    status          TEXT NOT NULL DEFAULT 'completed',
    error           TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_test_runs_user_date ON pipeline_test_runs (created_by_id, created_at DESC);
