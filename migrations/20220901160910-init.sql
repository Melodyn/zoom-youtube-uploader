--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

CREATE TABLE events (
  id      INTEGER PRIMARY KEY,
  state   TEXT    NOT NULL,
  data    TEXT    NOT NULL
);

CREATE INDEX events_ix_state ON events (state);


CREATE TABLE records (
  id                  INTEGER PRIMARY KEY,
  eventId             INTEGER NOT NULL,
  loadFromZoomState   TEXT    NOT NULL,
  loadFromZoomError   TEXT    NOT NULL DEFAULT "",
  loadToYoutubeState  TEXT    NOT NULL,
  loadToYoutubeError  TEXT    NOT NULL DEFAULT "",
  data                TEXT    NOT NULL,
  CONSTRAINT records_fk_eventId FOREIGN KEY (eventId) REFERENCES events (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX records_ix_eventId ON records (eventId);
CREATE INDEX records_ix_zoom ON records (loadFromZoomState);
CREATE INDEX records_ix_youtube ON records (loadToYoutubeState);


CREATE TABLE tokens (
  id    INTEGER PRIMARY KEY,
  token TEXT    NOT NULL
);
INSERT INTO tokens (token) VALUES ("{}");

--------------------------------------------------------------------------------
-- Down
--------------------------------------------------------------------------------

DROP INDEX events_ix_state;

DROP INDEX records_ix_eventId;
DROP INDEX records_ix_zoom;
DROP INDEX records_ix_youtube;

DROP TABLE events;
DROP TABLE records;
DROP TABLE tokens;
