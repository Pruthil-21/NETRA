CREATE TABLE watchlist (
    id            SERIAL PRIMARY KEY,
    plate_number  TEXT NOT NULL,
    reason        TEXT NOT NULL,
    dept_flagged  TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'medium',
    date_added    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
    id            SERIAL PRIMARY KEY,
    camera_id     INTEGER NOT NULL,
    plate_number  TEXT NOT NULL,
    watchlist_id  INTEGER REFERENCES watchlist(id),
    matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT NOT NULL DEFAULT 'NEW'
);

CREATE INDEX idx_watchlist_plate ON watchlist (plate_number);
CREATE INDEX idx_alerts_plate ON alerts (plate_number);
CREATE INDEX idx_alerts_status ON alerts (status);
